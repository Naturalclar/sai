// 終わったターンで実行したコマンド・ツールを、あとから見る（#605）。
// Claude の transcript / Codex の rollout をターンに切り、ターンごとに**ツールの呼び出しだけ**を並べる。
// 出すのはツール名と「何をしたか」（コマンド・ファイルのパスなど）まで。**ツールの出力は読まない・出さない**。
// 要約は許可のバブルと同じ作り（`shared/approvals.ts` の `toolSummary()`）。行（JSONL）には載せず、開いたときに派生で読むだけ
import { toolSummary } from './approvals.ts'
import { codexToolText } from './progress.ts'
import type { TurnStep } from './types.ts'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 1 手順の要約の上限（許可のバブルと同じ 300 字） */
export const TURN_STEP_TEXT_MAX = 300
/** 1 ターンで返す手順の上限。超えたら頭から切って、全部の数は `total` で返す */
export const TURN_STEPS_MAX = 500

const clip = (text: string) => {
  const chars = Array.from(text.trim())
  return chars.length <= TURN_STEP_TEXT_MAX ? chars.join('') : `${chars.slice(0, TURN_STEP_TEXT_MAX - 1).join('')}…`
}

export interface StepTurn {
  /** ターンの始まり（人の入力 / task_started）の時刻。読めなければ NaN */
  startedAt: number
  /** ターンの最後の動き（最後の assistant の行 / task_complete）の時刻。無ければ NaN */
  endedAt: number
  /** 人の入力の頭（突き合わせ用。Codex は空） */
  input: string
  steps: TurnStep[]
}

export interface StepParser {
  push: (line: string) => void
  turns: StepTurn[]
}

function parse(line: string): Obj | null {
  if (!line || line[0] !== '{') return null
  try {
    return obj(JSON.parse(line))
  } catch {
    return null
  }
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(obj)
    .filter((b) => b?.type === 'text')
    .map((b) => str(b?.text))
    .join('\n')
}

/**
 * Claude の transcript。人の入力（メタ・要約・ツールの戻り・サブエージェントでない user の行）でターンが始まり、
 * assistant の `tool_use` が手順になる。Bash の `description`（何のためか）は `note` に分ける（`summary` はコマンドそのもの）
 */
export function claudeStepParser(): StepParser {
  const turns: StepTurn[] = []
  let cur: StepTurn | null = null
  const push = (line: string) => {
    const o = parse(line)
    if (!o || o.isSidechain === true || o.isMeta === true) return
    const message = obj(o.message)
    const content = message?.content
    if (o.type === 'user') {
      if (o.isCompactSummary === true) return
      const blocks = Array.isArray(content) ? content.map(obj) : []
      if (blocks.some((b) => b?.type === 'tool_result')) return
      const input = userText(content).trim()
      if (!input) return
      cur = { startedAt: Date.parse(str(o.timestamp)), endedAt: NaN, input, steps: [] }
      turns.push(cur)
      return
    }
    if (o.type !== 'assistant' || !cur || !Array.isArray(content)) return
    const ts = str(o.timestamp)
    const at = Date.parse(ts)
    if (Number.isFinite(at)) cur.endedAt = at
    for (const raw of content) {
      const b = obj(raw)
      if (b?.type !== 'tool_use') continue
      const name = str(b.name)
      const input = obj(b.input) ?? {}
      const summary = clip(toolSummary(name, input))
      const note = clip(str(input.description))
      cur.steps.push({ tool: name, summary, at: ts, ...(note && note !== summary ? { note } : {}) })
    }
  }
  return { push, turns }
}

/** Codex の rollout。`task_started` でターンが始まり、`task_complete` で終わる。ツールは `custom_tool_call` / `function_call` */
export function codexStepParser(): StepParser {
  const turns: StepTurn[] = []
  let cur: StepTurn | null = null
  const push = (line: string) => {
    const o = parse(line)
    const payload = obj(o?.payload)
    if (!o || !payload) return
    const ts = str(o.timestamp)
    const at = Date.parse(ts)
    const type = payload.type
    if (o.type === 'event_msg') {
      if (type === 'task_started') {
        cur = { startedAt: at, endedAt: NaN, input: '', steps: [] }
        turns.push(cur)
      } else if (type === 'task_complete' && cur && Number.isFinite(at)) {
        cur.endedAt = at
      }
      return
    }
    if (o.type !== 'response_item' || !cur) return
    if (Number.isFinite(at)) cur.endedAt = at
    if (type === 'custom_tool_call' || type === 'function_call') {
      cur.steps.push({ tool: str(payload.name), summary: clip(codexToolText(type === 'custom_tool_call' ? payload.input : payload.arguments)), at: ts })
    }
  }
  return { push, turns }
}

/**
 * 頭から読むとき、JSON にしなくてよい行か（ツールの戻り。1 行に画像やファイルが丸ごと入っていて大きい）。
 * 手順に要るのは入力の行と assistant / response_item の行だけ。迷ったら読む
 */
export function skipForSteps(line: string): boolean {
  return line.includes('"type":"tool_result"') || line.includes('"type":"function_call_output"') || line.includes('"type":"custom_tool_call_output"')
}

/** 始まりの突き合わせの幅（入力の行と transcript の入力の行は同じ瞬間。行の ts は秒まで） */
export const STEP_START_SLACK_MS = 10_000
/** 終わりの突き合わせの幅（ターン完了の行は、最後の動きの少しあとに書かれる。`record.py` の締切は 15 秒） */
export const STEP_END_BEFORE_MS = 60_000
export const STEP_END_AFTER_MS = 5_000

const head = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 40)

/**
 * 記録の行に当たるターン。`startMs`（そのターンの入力の行の時刻）があれば始まりが近いもの（複数あれば入力の頭が同じ方）、
 * 無ければ `endMs`（ターン完了の行の時刻）の少し前に終わった一番新しいもの。**近いものが無ければ null**（別のターンの手順を出さない）
 */
export function findStepTurn(turns: readonly StepTurn[], at: { startMs?: number; endMs?: number; input?: string }): StepTurn | null {
  if (at.startMs !== undefined && Number.isFinite(at.startMs)) {
    const start = at.startMs
    const near = turns.filter((t) => Math.abs(t.startedAt - start) <= STEP_START_SLACK_MS)
    // 始まりが分かっているのに近いターンが無ければ、transcript にそのターンが無い（終わりの近さでは当てない）
    if (near.length === 0) return null
    const want = at.input ? head(at.input) : ''
    const same = want ? near.filter((t) => head(t.input) === want) : []
    return (same.length > 0 ? same : near).reduce((a, b) => (Math.abs(b.startedAt - start) < Math.abs(a.startedAt - start) ? b : a))
  }
  if (at.endMs !== undefined && Number.isFinite(at.endMs)) {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]!
      if (t.endedAt >= at.endMs - STEP_END_BEFORE_MS && t.endedAt <= at.endMs + STEP_END_AFTER_MS) return t
    }
  }
  return null
}

/** 畳んだ 1 行（`Bash 12・Edit 3・Read 2`）。多い順、同数は出てきた順 */
export function stepCounts(steps: readonly Pick<TurnStep, 'tool'>[]): string {
  const counts = new Map<string, number>()
  for (const s of steps) counts.set(s.tool || 'ツール', (counts.get(s.tool || 'ツール') ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).map(([tool, n]) => `${tool} ${n}`).join('・')
}
