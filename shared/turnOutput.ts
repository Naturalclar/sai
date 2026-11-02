// 手順の 1 つを開いたときの、コマンドの出力と編集の差分（#846）。Claude の transcript / Codex の rollout の行から組む純粋関数。
// 読むのは `server/local/progress.ts` の `turnOutput()`、出すのは `web/src/StepOutput.tsx`。
//
// - **出力には秘密が混ざりうる。** 行（JSONL）にも `steps` にも載せず、押したときだけ読んで応答に載せる。覚えない
// - 出すのはコマンドの出力と編集の差分まで（`Read` の中身・MCP の戻りは出さない）。秘密に見えるパス（`isSecretPath()`）の編集は中身を出さない
// - 実測（codex-cli 0.162〜0.166 の rollout）: `custom_tool_call` の `exec` 1 回に、`item_completed` の `CommandExecution` が 0〜5 個続く。
//   項目の `id` は `call_id` と別物なので、**呼び出しの行から、自分の戻りのあとの次の呼び出しまで**にある項目を集める。
//   同時に投げた呼び出しは同じ項目が両方に出るが、節の見出しに実際のコマンドを出すので取り違えない（自分の戻りの文も一緒に出す）
import { isSecretPath } from './files.ts'
import type { TurnOutputSection } from './types.ts'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 節の頭と末尾に残す字数。テストやビルドの結果は末尾に出るので、末尾を厚く残す */
export const TURN_OUTPUT_HEAD = 6_000
export const TURN_OUTPUT_TAIL = 24_000
/** 1 つの手順で返す節の数（Codex の `exec` は 1 回で複数のコマンドを回す） */
export const TURN_OUTPUT_SECTIONS_MAX = 20
/** 節の見出しの長さ（コマンド全体を出すものではない。全体は手順の行にある） */
const LABEL_MAX = 200
/** 頭と末尾の切り口を行の境目に寄せる幅。これより長い 1 行は字数で切る */
const LINE_SNAP = 400

const OUTPUT_TOOLS_CLAUDE = new Set(['Bash', 'BashOutput'])
const EDIT_TOOLS_CLAUDE = new Set(['Edit', 'MultiEdit', 'Write'])
const OUTPUT_TOOLS_CODEX = new Set(['exec', 'exec_command', 'shell', 'shell_command', 'local_shell', 'container.exec', 'write_stdin', 'wait'])

/** 手順から開けるツールか。開けないものには `output_ref` を付けない */
export function claudeOutputKind(tool: string): 'output' | 'diff' | null {
  if (OUTPUT_TOOLS_CLAUDE.has(tool)) return 'output'
  return EDIT_TOOLS_CLAUDE.has(tool) ? 'diff' : null
}

export function codexOutputKind(tool: string): 'output' | 'diff' | null {
  if (OUTPUT_TOOLS_CODEX.has(tool)) return 'output'
  return tool === 'apply_patch' ? 'diff' : null
}

/** リクエストの `ref` として受ける形（`tool_use.id` / `call_id`）。行と突き合わせる前に形を見る */
export function isOutputRef(ref: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(ref)
}

const ESC = '\\u001b'
/** 色・カーソルの制御列（CSI と OSC）。端末でないところでは読めない記号になる */
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^\\u0007\\u001b]*(?:\\u0007|${ESC}\\\\)`, 'g')

/** 制御列を落とし、改行を `\n` に揃える */
export function plainOutput(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n?/g, '\n')
}

const nextLine = (text: string, at: number) => {
  const i = text.indexOf('\n', at)
  return i >= 0 && i - at <= LINE_SNAP ? i + 1 : at
}
const prevLine = (text: string, at: number) => {
  const i = text.lastIndexOf('\n', at)
  return i >= 0 && at - i <= LINE_SNAP ? i + 1 : at
}

/** 長い本文を頭と末尾だけにする。切り口はなるべく行の境目に寄せる */
export function clipOutput(text: string): Pick<TurnOutputSection, 'text' | 'tail' | 'omitted'> {
  if (text.length <= TURN_OUTPUT_HEAD + TURN_OUTPUT_TAIL) return { text }
  const end = prevLine(text, TURN_OUTPUT_HEAD)
  const start = nextLine(text, text.length - TURN_OUTPUT_TAIL)
  return { text: text.slice(0, end), tail: text.slice(start), omitted: start - end }
}

const textSection = (label: string, raw: string, extra: Pick<TurnOutputSection, 'exit_code' | 'failed'> = {}): TurnOutputSection => ({ label, kind: 'output', ...clipOutput(plainOutput(raw)), ...extra })

const diffSection = (path: string, diff: string): TurnOutputSection =>
  isSecretPath(path) ? { label: path, kind: 'diff', text: '', withheld: true } : { label: path, kind: 'diff', ...clipOutput(plainOutput(diff)) }

const prefixed = (mark: '+' | '-', content: string) => content.replace(/\n$/, '').split('\n').map((l) => `${mark}${l}`).join('\n')

/** 差分の 1 行の種類（画面の色分け）。`+++` / `---` は見出し */
export function diffLineKind(line: string): 'add' | 'del' | 'head' | 'ctx' {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('*** ')) return 'head'
  if (line.startsWith('+')) return 'add'
  return line.startsWith('-') ? 'del' : 'ctx'
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(obj).filter((b) => b?.type === 'text').map((b) => str(b?.text)).join('\n')
}

function claudePatch(result: Obj): string {
  const hunks = Array.isArray(result.structuredPatch) ? result.structuredPatch.map(obj) : []
  const body = hunks
    .flatMap((h) => {
      if (!h) return []
      const lines = Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === 'string') : []
      return [`@@ -${String(h.oldStart ?? 0)},${String(h.oldLines ?? 0)} +${String(h.newStart ?? 0)},${String(h.newLines ?? 0)} @@`, ...lines]
    })
    .join('\n')
  if (body) return body
  // 新しいファイルの `Write` は hunk が空で、本文が `content` にある（`update` で hunk が空なのは中身が変わっていない）
  return result.type === 'create' && typeof result.content === 'string' ? prefixed('+', result.content) : ''
}

/** Claude の `tool_result` の行。`toolUseResult` が読めないとき（失敗は文字列で入る）は戻りの文を出す */
function claudeSections(line: Obj, block: Obj): TurnOutputSection[] {
  const failed = block.is_error === true ? ({ failed: true } as const) : {}
  const result = obj(line.toolUseResult)
  const path = str(result?.filePath)
  const patch = result ? claudePatch(result) : ''
  if (path && patch) return [{ ...diffSection(path, patch), ...failed }]
  if (path && isSecretPath(path)) return [{ label: path, kind: 'diff', text: '', withheld: true }]
  const stdout = str(result?.stdout)
  const stderr = str(result?.stderr)
  if (stdout || stderr) return [...(stdout ? [textSection('stdout', stdout, failed)] : []), ...(stderr ? [textSection('stderr', stderr, failed)] : [])]
  const text = resultText(block.content)
  return text ? [textSection('出力', text, failed)] : []
}

export interface OutputFinder {
  /** 1 行渡す。もう読まなくてよいときは true */
  push: (line: string) => boolean
  /** 頭から読むとき、JSON にしなくてよい行か（大半の行を飛ばす） */
  skip: (line: string) => boolean
  sections: () => TurnOutputSection[]
}

function parse(line: string): Obj | null {
  if (!line || line[0] !== '{') return null
  try {
    return obj(JSON.parse(line))
  } catch {
    return null
  }
}

/**
 * Claude: `tool_use_id` が `ref` の `tool_result` の行だけを見る。見つかったらそこで止める。
 * 編集が失敗すると戻りにパスが載らず、エラーの文に編集しようとした文字列が入りうるので、秘密のパスは呼び出しの側でも見る
 */
export function claudeOutputFinder(ref: string): OutputFinder {
  let found: TurnOutputSection[] = []
  let secret = ''
  return {
    skip: (line) => !line.includes(ref),
    sections: () => found,
    push: (line) => {
      const o = parse(line)
      const content = obj(o?.message)?.content
      if (!o || !Array.isArray(content)) return false
      if (o.type === 'assistant') {
        const use = content.map(obj).find((b) => b?.type === 'tool_use' && b.id === ref)
        const path = str(obj(use?.input)?.file_path)
        if (use && claudeOutputKind(str(use.name)) === 'diff' && isSecretPath(path)) secret = path
        return false
      }
      if (o.type !== 'user') return false
      const block = content.map(obj).find((b) => b?.type === 'tool_result' && b.tool_use_id === ref)
      if (!block) return false
      found = secret ? [{ label: secret, kind: 'diff', text: '', withheld: true }] : claudeSections(o, block)
      return true
    },
  }
}

function codexOutputText(output: unknown): string {
  if (Array.isArray(output)) return output.map(obj).map((b) => str(b?.text)).filter(Boolean).join('\n')
  const text = str(output)
  // 古い `function_call_output` は `{ "output": "...", "metadata": {...} }` の JSON の文字列
  if (text.startsWith('{')) {
    const inner = parse(text)
    if (typeof inner?.output === 'string') return inner.output
  }
  return text
}

const codexCommand = (command: unknown) => {
  const text = Array.isArray(command) ? str(command.at(-1)) : str(command)
  const chars = Array.from(text.trim().replace(/\s+/g, ' '))
  return chars.length <= LABEL_MAX ? chars.join('') : `${chars.slice(0, LABEL_MAX - 1).join('')}…`
}

function codexChanges(changes: unknown): TurnOutputSection[] {
  return Object.entries(obj(changes) ?? {}).map(([path, raw]) => {
    const change = obj(raw)
    const diff = str(change?.unified_diff)
    const content = str(change?.content)
    return diffSection(path, diff || (content ? prefixed(change?.type === 'delete' ? '-' : '+', content) : ''))
  })
}

/** `apply_patch` の呼び出しの本文（`custom_tool_call` はそのまま、`function_call` は引数の JSON の `input`） */
function codexPatch(payload: Obj): string {
  if (payload.type === 'custom_tool_call') return str(payload.input)
  return str(parse(str(payload.arguments))?.input)
}

/** パッチの本文に秘密に見えるパスの編集があるか */
function patchTouchesSecret(patch: string): boolean {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm), ...patch.matchAll(/^\*\*\* Move to: (.+)$/gm)].some((m) => isSecretPath(str(m[1]).trim()))
}

/**
 * Codex: `call_id` が `ref` の呼び出しの行から、自分の戻りのあとの次の呼び出し（かターンの切れ目）までを見る。
 * `CommandExecution` / `FileChange` の項目があればそれを出し、無ければ（項目を書かない版）呼び出しの本文と戻りの文を出す。
 * 同時に投げた呼び出しがあるときは、項目が自分のものとは限らないので戻りの文も出す（自分の分が消えないように）。
 * `apply_patch` は自分のパッチより先にほかのコマンドの項目を出さない
 */
export function codexOutputFinder(ref: string): OutputFinder {
  const items: TurnOutputSection[] = []
  let call: Obj | null = null
  let returned = ''
  let closed = false
  let overlapped = false
  /** 戻りがまだ来ていない、ほかの呼び出し（同じターンの中だけ） */
  const others = new Set<string>()
  const sections = (): TurnOutputSection[] => {
    if (call && str(call.name) === 'apply_patch') {
      const changes = items.filter((s) => s.kind === 'diff')
      if (changes.length > 0) return changes
      const patch = codexPatch(call)
      if (patchTouchesSecret(patch)) return [{ label: 'パッチ', kind: 'diff', text: '', withheld: true }]
      if (patch) return [diffSection('パッチ', patch)]
    }
    const own = returned ? [textSection(items.length > 0 ? 'この呼び出しの戻り' : '出力', returned)] : []
    if (items.length === 0) return own
    return overlapped ? [...own, ...items] : items
  }
  return {
    sections,
    // 呼び出しの前は `ref` のある行と、同時に投げた呼び出しを知るためのツールの行だけ。呼び出しのあとは項目と次の呼び出しを全部見る
    skip: (line) => !call && !line.includes(ref) && !line.includes('_call') && !line.includes('task_started'),
    push: (line) => {
      const o = parse(line)
      const payload = obj(o?.payload)
      if (!o || !payload) return false
      const type = payload.type
      if (o.type === 'response_item' && (type === 'custom_tool_call' || type === 'function_call')) {
        if (payload.call_id === ref && !call) {
          call = payload
          overlapped = others.size > 0
          return false
        }
        // 自分の戻りより前の呼び出しは、同時に投げたもの。まだ閉じない
        if (call && closed) return true
        if (call) overlapped = true
        others.add(str(payload.call_id))
        return false
      }
      if (o.type === 'response_item' && (type === 'custom_tool_call_output' || type === 'function_call_output')) {
        others.delete(str(payload.call_id))
        if (call && payload.call_id === ref) {
          returned = codexOutputText(payload.output)
          closed = true
        }
        return false
      }
      if (!call) {
        if (o.type === 'event_msg' && type === 'task_started') others.clear()
        return false
      }
      if (o.type !== 'event_msg') return false
      if (type === 'task_started' || type === 'task_complete') return true
      const item = obj(payload.item)
      if (type !== 'item_completed' || !item) return false
      if (item.type === 'CommandExecution') {
        const code = typeof item.exit_code === 'number' ? item.exit_code : undefined
        items.push(textSection(codexCommand(item.command) || 'コマンド', str(item.aggregated_output), { ...(code !== undefined && code !== 0 ? { exit_code: code, failed: true as const } : {}) }))
      } else if (item.type === 'FileChange') {
        items.push(...codexChanges(item.changes))
      }
      return false
    },
  }
}
