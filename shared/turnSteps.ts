// 終わったターンで実行したコマンド・ツールを、あとから見る（#605）。
// Claude の transcript / Codex の rollout をターンに切り、ターンごとに**ツールの呼び出しと、途中で書いた文（#680）**を並べる。
// 出すのはツール名と「何をしたか」（コマンド・ファイルのパスなど）まで。**ツールの出力は読まない・出さない**。
// 最後の返答（Claude は `end_turn` の文、Codex は `phase: commentary` でない文）は行として届いているので入れない。
// 要約は許可のバブルと同じ作り（`shared/approvals.ts` の `toolSummary()`）。行（JSONL）には載せず、開いたときに派生で読むだけ
import { toolSummary } from './approvals.ts'
import { codexToolText, PROGRESS_NOTE_MAX } from './progress.ts'
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

const clipText = (text: string) => {
  const chars = Array.from(text.trim())
  return chars.length <= PROGRESS_NOTE_MAX ? chars.join('') : `${chars.slice(0, PROGRESS_NOTE_MAX - 1).join('')}…`
}

/** 途中で書いた文の手順（#680） */
const textStep = (text: string, at: string): TurnStep => ({ tool: '', summary: '', at, text: clipText(text) })

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
    // 最後の返答の文（`end_turn` / `stop_sequence` の行）は行として届いているので、途中の文にしない
    const final = message?.stop_reason === 'end_turn' || message?.stop_reason === 'stop_sequence'
    for (const raw of content) {
      const b = obj(raw)
      if (b?.type === 'text' && !final && str(b.text).trim()) cur.steps.push(textStep(str(b.text), ts))
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
    } else if (type === 'message' && payload.role === 'assistant' && payload.phase === 'commentary') {
      const text = (Array.isArray(payload.content) ? payload.content : []).map((c) => str(obj(c)?.text)).join('\n')
      if (text.trim()) cur.steps.push(textStep(text, ts))
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
/** 終わりの突き合わせの幅（ターン完了の行は、最後の動きの少しあとに書かれる。`record.py` の締切は 15 秒なので、その少し外まで） */
export const STEP_END_BEFORE_MS = 20_000
export const STEP_END_AFTER_MS = 5_000

const head = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 40)

/** Esc で止めたときに Claude が書く入力の行。ここで前の流れは切れている */
const isInterrupt = (input: string) => input.startsWith('[Request interrupted')

/**
 * 記録の行（ターン完了の行）に当たるターン。**1 つの記録のターンが transcript では複数に切れていることがある**
 * （ターンの途中で入力が足された = steer・タスクの通知）ので、始まりから終わりまでをつないで 1 つにして返す（#663 のレビュー）。
 * - 「終わり」は `endMs`（ターン完了の行の時刻）の少し前に終わった一番新しいターン
 * - 「始まり」は `starts`（前のターン完了の行より後の入力の行。古い順）のうち、transcript に近いターンがある最初のもの
 *   （±10 秒。複数あれば入力の頭が同じ方）。Esc ですぐ止めた入力は transcript に残らないことがあるので、次の入力を試す
 * - 始まりから終わりまでの間に Esc で止めた跡があれば、その後ろからにする（止めたターンの手順を、次のターンのものとして出さない）
 * - 始まりだけ見つかったら（ターン完了のあともそのターンが続いた・行が遅れて書かれた）、そのターンを返す
 * - 始まりが 1 つも見つからなければ、終わりだけで当てる。それも無ければ null（別のターンの手順を出さない）
 */
export function findStepTurn(turns: readonly StepTurn[], at: { starts?: readonly { ms: number; input?: string }[]; endMs?: number }): StepTurn | null {
  let endIdx = -1
  if (at.endMs !== undefined && Number.isFinite(at.endMs)) {
    for (let i = turns.length - 1; i >= 0 && endIdx < 0; i--) {
      const t = turns[i]!
      if (t.endedAt >= at.endMs - STEP_END_BEFORE_MS && t.endedAt <= at.endMs + STEP_END_AFTER_MS) endIdx = i
    }
  }
  let startIdx = -1
  for (const start of at.starts ?? []) {
    if (!Number.isFinite(start.ms)) continue
    const near = turns.map((t, i) => ({ t, i })).filter(({ t }) => Math.abs(t.startedAt - start.ms) <= STEP_START_SLACK_MS)
    if (near.length === 0) continue
    const want = start.input ? head(start.input) : ''
    const same = want ? near.filter(({ t }) => head(t.input) === want) : []
    startIdx = (same.length > 0 ? same : near).reduce((a, b) => (Math.abs(b.t.startedAt - start.ms) < Math.abs(a.t.startedAt - start.ms) ? b : a)).i
    break
  }
  if (startIdx < 0) return endIdx >= 0 ? turns[endIdx]! : null
  if (endIdx < startIdx) return turns[startIdx]!
  let from = startIdx
  for (let i = startIdx + 1; i <= endIdx; i++) if (isInterrupt(turns[i]!.input)) from = Math.min(i + 1, endIdx)
  if (from === endIdx) return turns[endIdx]!
  const first = turns[from]!
  return { startedAt: first.startedAt, endedAt: turns[endIdx]!.endedAt, input: first.input, steps: turns.slice(from, endIdx + 1).flatMap((t) => t.steps) }
}

/** 畳んだ 1 行（`Bash 12・Edit 3・Read 2`）。多い順、同数は出てきた順 */
export function stepCounts(steps: readonly Pick<TurnStep, 'tool' | 'text'>[]): string {
  const counts = new Map<string, number>()
  for (const s of steps) if (s.text === undefined) counts.set(s.tool || 'ツール', (counts.get(s.tool || 'ツール') ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).map(([tool, n]) => `${tool} ${n}`).join('・')
}
