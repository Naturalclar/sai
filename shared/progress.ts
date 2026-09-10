// 処理中のターンが何をしているか（#302）。Claude の transcript と Codex の rollout の行から、
// 「いまのターンの手順」（ツールを呼んだ・考えた・返答を書いた）を組み立てる純粋関数。
// 読むのはサーバ（server/local/progress.ts）、出すのは画面（web/src/ProgressSteps.tsx）。
//
// 実測（#302）: transcript の tool_use は**実行前に**、tool_result は終わってから追記されるので、走っている間は
// tool_use の行だけがある。thinking は 694 個のうち本文が入っていたのが 30 個で、中身は出さない（「考え中」だけ）
import { toolSummary } from './approvals.ts'
import type { ProgressStep } from './types.ts'

/** 画面に返す手順の数（ターンの末尾から） */
export const PROGRESS_STEPS = 8
/** 要約の長さ。画面は 1 行で切るので、許可待ち（300 文字）より短くてよい */
export const PROGRESS_SUMMARY_MAX = 200
/**
 * ターンが閉じていなくても、走っているツールが無いままこれより長く書かれていなければ「止まっている」。
 * 端末で Esc を押して止めたターンは閉じないまま残る（#302 の実測で 536 件中 13 件）。
 * 長い考え中は書き込みが無いまま続くので、短くしすぎない
 */
export const PROGRESS_IDLE_MS = 10 * 60_000
/** 走っているツールを信じる上限。止めたのに tool_result が書かれなかったときに、ずっと「処理中」にしない */
export const PROGRESS_TOOL_MAX_MS = 3 * 60 * 60_000
/** これより長く同じツールが走っていたら、長引いているとして色を変える（仮バブルの LONG_REPLY_MS と同じ 5 分） */
export const PROGRESS_LONG_STEP_MS = 5 * 60_000
/** 送った時刻（か入力の行の時刻）からさかのぼって手順を残す幅。行の ts は記録した時刻で、transcript と少しずれる */
export const PROGRESS_SINCE_SLACK_MS = 10_000

export interface ParsedProgress {
  /** そのターンの手順（古い順、全部） */
  steps: ProgressStep[]
  /** ターンの始まり（人の入力 / task_started）を見たか。見ていなければ、読んだ範囲がターンの途中から始まっている */
  started: boolean
  /** ターンが閉じていない（最後の assistant の行が tool_use で止まっている、または入力のあと返答がまだ） */
  open: boolean
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function parseLine(line: string): Obj | null {
  if (!line.trim()) return null
  try {
    return obj(JSON.parse(line))
  } catch {
    return null
  }
}

/** 空でない最初の 1 行だけにして、長ければ切る */
export function oneLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  const chars = Array.from(line)
  return chars.length <= PROGRESS_SUMMARY_MAX ? line : `${chars.slice(0, PROGRESS_SUMMARY_MAX - 1).join('')}…`
}

/** Claude Code が transcript を置くディレクトリの名前。cwd の英数字と `-` 以外を `-` にしたもの（#302 で手元の 19 セッションすべて一致） */
export const claudeProjectName = (cwd: string): string => cwd.replace(/[^A-Za-z0-9-]/g, '-')

/**
 * Claude のツール呼び出しの要約。`description`（Bash / Agent に付く「何のためか」の一文）があればそれ、
 * 無ければ許可待ちと同じ要約（`toolSummary()`。コマンド・ファイルのパス・URL など）
 */
export function claudeToolSummary(name: string, input: unknown): string {
  const o = obj(input) ?? {}
  return oneLine(str(o.description).trim() || toolSummary(name, o))
}

const CODEX_KEYS = ['cmd', 'command', 'path', 'file_path', 'url', 'query', 'pattern']

/**
 * Codex のツール呼び出しの要約。`exec` は JavaScript を渡す形（`tools.exec_command({"cmd":"…"})`）なので `cmd` を拾い、
 * `function_call` は引数の JSON から `cmd` / `command`（配列なら最後の要素 = `bash -lc` の中身）などを取る。
 * 分からなければ空（コードや JSON をそのまま出しても読めない）
 */
export function codexToolSummary(raw: unknown): string {
  const text = str(raw)
  if (!text.trim()) return ''
  const quoted = /"cmd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text)?.[1]
  if (quoted) {
    try {
      return oneLine(String(JSON.parse(quoted)))
    } catch {
      // 引数の JSON として読み直す
    }
  }
  let args: Obj | null = null
  try {
    args = obj(JSON.parse(text))
  } catch {
    return ''
  }
  if (!args) return ''
  for (const key of CODEX_KEYS) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return oneLine(v)
    if (Array.isArray(v)) {
      const last = v.filter((x): x is string => typeof x === 'string').at(-1)
      if (last?.trim()) return oneLine(last)
    }
  }
  return ''
}

/** 考えた・書いたが続くとき（1 つの返答が行に分かれて書かれる）は 1 手順にまとめる */
function pushStep(steps: ProgressStep[], next: ProgressStep): void {
  const last = steps[steps.length - 1]
  if (last && next.kind !== 'tool' && last.kind === next.kind) {
    last.ended = next.ended
    if (next.summary) last.summary = next.summary
    return
  }
  steps.push(next)
}

/**
 * Claude の transcript の行（古い順）から、最後のターンの手順。
 * - 人の入力（`isMeta` / 要約でない user の行で、tool_result でないもの）でターンが始まる
 * - assistant の行は内容の塊ごとに分かれて書かれ、どれにも同じ `stop_reason` が付く。`tool_use` なら続き、
 *   `end_turn` / `stop_sequence` なら閉じた（手元の transcript で、入力の直前の assistant の行は 103 件すべてこの 2 つ）
 * - サブエージェントの行（`isSidechain`）は見ない
 */
export function claudeProgress(lines: readonly string[]): ParsedProgress {
  let steps: ProgressStep[] = []
  let tools = new Map<string, ProgressStep>()
  let started = false
  let open = false
  for (const line of lines) {
    const o = parseLine(line)
    if (!o || o.isSidechain === true) continue
    const ts = str(o.timestamp)
    const message = obj(o.message)
    const content = message?.content
    if (o.type === 'user') {
      if (o.isMeta === true || o.isCompactSummary === true) continue
      const blocks = Array.isArray(content) ? content.map(obj) : []
      const results = blocks.filter((b) => b?.type === 'tool_result')
      if (results.length > 0) {
        for (const b of results) {
          const step = tools.get(str(b?.tool_use_id))
          if (step && !step.ended) step.ended = ts
        }
        continue
      }
      const said = typeof content === 'string' ? content.trim() !== '' : blocks.some((b) => b?.type === 'text')
      if (said) {
        steps = []
        tools = new Map()
        started = true
        open = true
      }
      continue
    }
    if (o.type !== 'assistant' || !Array.isArray(content)) continue
    for (const raw of content) {
      const b = obj(raw)
      if (!b) continue
      if (b.type === 'tool_use') {
        const step: ProgressStep = { kind: 'tool', tool: str(b.name), summary: claudeToolSummary(str(b.name), b.input), started: ts }
        steps.push(step)
        tools.set(str(b.id), step)
      } else if (b.type === 'thinking') {
        pushStep(steps, { kind: 'thinking', summary: '', started: ts, ended: ts })
      } else if (b.type === 'text' && str(b.text).trim()) {
        pushStep(steps, { kind: 'text', summary: oneLine(str(b.text)), started: ts, ended: ts })
      }
    }
    const stop = message?.stop_reason
    if (stop === 'tool_use') open = true
    else if (stop === 'end_turn' || stop === 'stop_sequence') open = false
  }
  return { steps, started, open }
}

/**
 * Codex の rollout の行（古い順）から、最後のターンの手順。
 * `event_msg` の `task_started` でターンが始まり、`task_complete` で閉じる。
 * ツールは `response_item` の `custom_tool_call` / `function_call`（`call_id` で `*_output` と組になる）
 */
export function codexProgress(lines: readonly string[]): ParsedProgress {
  let steps: ProgressStep[] = []
  let tools = new Map<string, ProgressStep>()
  let started = false
  let open = false
  for (const line of lines) {
    const o = parseLine(line)
    const payload = obj(o?.payload)
    if (!o || !payload) continue
    const ts = str(o.timestamp)
    const type = payload.type
    if (o.type === 'event_msg') {
      if (type === 'task_started') {
        steps = []
        tools = new Map()
        started = true
        open = true
      } else if (type === 'task_complete') {
        open = false
      }
      continue
    }
    if (o.type !== 'response_item') continue
    if (type === 'custom_tool_call' || type === 'function_call') {
      const step: ProgressStep = { kind: 'tool', tool: str(payload.name), summary: codexToolSummary(type === 'custom_tool_call' ? payload.input : payload.arguments), started: ts }
      steps.push(step)
      tools.set(str(payload.call_id), step)
    } else if (type === 'custom_tool_call_output' || type === 'function_call_output') {
      const step = tools.get(str(payload.call_id))
      if (step && !step.ended) step.ended = ts
    } else if (type === 'reasoning') {
      pushStep(steps, { kind: 'thinking', summary: '', started: ts, ended: ts })
    } else if (type === 'message' && payload.role === 'assistant') {
      const text = (Array.isArray(payload.content) ? payload.content : []).map((c) => str(obj(c)?.text)).join('\n')
      if (text.trim()) pushStep(steps, { kind: 'text', summary: oneLine(text), started: ts, ended: ts })
    }
  }
  return { steps, started, open }
}

/**
 * そのターンがいま動いているか。閉じていれば動いていない。閉じていなければ、
 * 走っているツールが PROGRESS_TOOL_MAX_MS 以内に始まっていれば動いている（長いコマンドの間は書き込みが無い）、
 * そうでなければ最後の書き込みが PROGRESS_IDLE_MS 以内なら動いている
 */
export function progressActive(parsed: ParsedProgress, mtimeMs: number, now: number): boolean {
  if (!parsed.open) return false
  const running = parsed.steps.some((s) => {
    if (s.kind !== 'tool' || s.ended) return false
    const t = Date.parse(s.started)
    return !Number.isNaN(t) && now - t < PROGRESS_TOOL_MAX_MS
  })
  return running || now - mtimeMs < PROGRESS_IDLE_MS
}

/** 画面に出す 1 行。`Bash: pnpm test` / `考え中` / `返答: …` */
export function stepLabel(step: ProgressStep): string {
  if (step.kind === 'thinking') return '考え中'
  if (step.kind === 'text') return step.summary ? `返答: ${step.summary}` : '返答を書いている'
  const tool = step.tool || 'ツール'
  return step.summary ? `${tool}: ${step.summary}` : tool
}

/** 手順にかかった時間。`42秒` / `3分10秒` / `1時間5分`。読めなければ空 */
export function progressDuration(started: string, until: number): string {
  const t = Date.parse(started)
  if (Number.isNaN(t)) return ''
  const seconds = Math.max(0, Math.floor((until - t) / 1000))
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`
}

/**
 * 送った時刻（か入力の行の時刻）より前に始まった手順を落とす。新しいターンの入力が transcript に届く前は、
 * 最後のターンが前のターンのままなので、その手順を「いま」に見せない
 */
export function stepsSince(steps: readonly ProgressStep[], since: string): ProgressStep[] {
  const t = Date.parse(since)
  if (Number.isNaN(t)) return [...steps]
  return steps.filter((s) => {
    const started = Date.parse(s.started)
    return Number.isNaN(started) || started >= t - PROGRESS_SINCE_SLACK_MS
  })
}
