// 端末で開いている Codex が出している許可・質問のダイアログを、tmux の画面から読む（#425）。
//
// `notify` はターン完了でしか鳴らず、通常起動の TUI からは app-server の server request も購読できないので、
// **何を聞かれているかは画面にしか無い**。`promptState()` はその画面を `kind: 'dialog'` の判定にだけ使って
// 捨てていたので、SAI 側には「待っている」の 1 行しか出ていなかった。
//
// **読むだけ**で、答えるのは今までどおり端末（キーを送ると誤って選びうる。#208）。
//
// 画面の形（codex 0.154.0 で実測。要素の間に空行が入るので、空行を落としてから読む）:
//
//   ⚠ MCP startup incomplete (failed: linear)        ← ここまでは会話（字下げが無い）
//     Would you like to run the following command?    ← ここから 2 文字下げがダイアログ
//     Environment: local
//     Reason: この worktree の変更をコミットするため、…
//     $ git add -A
//   › 1. Yes, proceed (y)                             ← いまカーソルが当たっている行だけ `›`
//     2. Yes, and don't ask again for commands that start with `git add` (p)
//     3. No, and tell Codex what to do differently (esc)
//     Press enter to confirm or esc to cancel         ← 終わりの行
//
// 会話の側は字下げが無いので、**選択肢から上へ「2 文字下げの行」を辿る**だけで塊が切り出せる。
// 人の入力欄（`› マージして`）も `›` で始まるが、番号付きの選択肢ではないので境目になる。
import type { TerminalDialog, TerminalDialogOption } from './types.ts'

/** ダイアログの終わりの行。`server/reply/terminal.ts` の DIALOG（検出）と同じ言い回し */
const FOOTER = /Enter to (?:confirm|select|submit)|Esc to cancel|Press enter to continue|Waiting for user input/i
/** 選択肢の行（印と字下げを落としたあと） */
const OPTION = /^(\d+)\.\s+(.*)$/
/** 行の頭の選択の印 */
const MARKER = /^[›❯>][\s\u00a0]?/
/** ダイアログの本文の字下げ（2 文字） */
const INDENT = /^ {2}\S/
/** 画面のうち遡って見る行数。これより上に伸びるダイアログは頭が切れるだけ（`title` が空になる） */
const MAX_LINES = 60
const MAX_TITLE = 200
const MAX_DETAIL = 2000
const MAX_COMMAND = 4000
const MAX_OPTIONS = 12
const MAX_LABEL = 400
/** `text` に出すコマンド・見出しの長さ */
const MAX_SUMMARY = 80

/** ダイアログの中身が読めなかったときの 1 行（#208 からの文言） */
export const CODEX_DIALOG_TEXT = 'Codex の画面で質問または許可への回答を待っている'

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 印か字下げを落とした本体と、印が付いていたか */
function bodyOf(line: string): { body: string; selected: boolean } {
  if (MARKER.test(line)) return { body: line.replace(MARKER, ''), selected: true }
  return { body: line.replace(/^ {2}/, ''), selected: false }
}

function isOption(line: string): boolean {
  return OPTION.test(bodyOf(line).body)
}

/** ダイアログの塊の行か。人の入力欄（`› マージして`）は選択肢ではないので入らない */
function isDialogLine(line: string): boolean {
  return INDENT.test(line) || isOption(line)
}

/**
 * 会話の側の引用の枠（`  │ - remove …` / `  └ error …`）。**字下げはダイアログと同じ 2 文字**なので、
 * ここで遡るのを止めないと見出しが枠の行になる（実機の `gh pr create` の許可で当たった）
 */
function isBoxLine(line: string): boolean {
  return /^[\u2500-\u257f]/.test(bodyOf(line).body)
}

/**
 * 画面からダイアログの中身を組み立てる。**選択肢が 1 つも読めなければ null**
 * （形の違うダイアログや、画面が想定と違うとき。呼ぶ側は今までどおりの 1 行に落ちる）
 */
export function parseCodexDialog(screen: string): TerminalDialog | null {
  const lines = screen
    .split('\n')
    .map((l) => l.replace(/[\s\u00a0]+$/, ''))
    .filter((l) => l.trim())
    .slice(-MAX_LINES)
  const footer = lastIndex(lines, (l) => FOOTER.test(l))
  const lastOption = lastIndex(lines, isOption)
  // 終わりの行があればその 1 つ上まで、無ければ一番下の選択肢まで
  const end = footer >= 0 ? footer - 1 : lastOption
  if (end < 0 || lastOption < 0 || lastOption > end) return null
  if (!isDialogLine(lines[end]!)) return null
  let start = end
  while (start > 0 && isDialogLine(lines[start - 1]!) && !isBoxLine(lines[start - 1]!)) start--

  const head: string[] = []
  const command: string[] = []
  const options: TerminalDialogOption[] = []
  for (const line of lines.slice(start, end + 1)) {
    const { body, selected } = bodyOf(line)
    const option = OPTION.exec(body)
    if (option) {
      if (options.length < MAX_OPTIONS) options.push({ number: Number(option[1]), label: clip(option[2]!.trim(), MAX_LABEL), selected })
      continue
    }
    if (options.length) {
      // 画面の幅で折り返された選択肢の続き
      const last = options[options.length - 1]!
      last.label = clip(`${last.label} ${body.trim()}`.trim(), MAX_LABEL)
      continue
    }
    if (body.startsWith('$ ')) {
      command.push(body.slice(2))
      continue
    }
    if (command.length) {
      command.push(body)
      continue
    }
    head.push(body.trim())
  }
  if (!options.length) return null
  return {
    title: clip(head[0] ?? '', MAX_TITLE),
    detail: clip(head.slice(1).join('\n'), MAX_DETAIL),
    command: clip(command.join('\n'), MAX_COMMAND),
    options,
  }
}

/**
 * 一覧・要対応に出る 1 行。コマンドの許可なら**そのコマンド**、質問なら見出しを出す。
 * 読めなかったときは今までどおり `CODEX_DIALOG_TEXT`
 */
export function codexDialogText(dialog: TerminalDialog | null): string {
  if (!dialog) return CODEX_DIALOG_TEXT
  const command = dialog.command.split('\n')[0]?.trim() ?? ''
  if (command) return `Codex の許可待ち: ${clip(command, MAX_SUMMARY)}`
  const title = dialog.title.trim()
  return title ? `Codex の質問: ${clip(title, MAX_SUMMARY)}` : CODEX_DIALOG_TEXT
}

/** 中身が変わったかを見るための鍵（同じダイアログを出し続けている間は変わらない） */
export function codexDialogKey(dialog: TerminalDialog | null): string {
  if (!dialog) return ''
  return [dialog.title, dialog.detail, dialog.command, ...dialog.options.map((o) => `${o.number}.${o.label}`)].join('\u0000')
}

function lastIndex(lines: readonly string[], test: (line: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (test(lines[i]!)) return i
  return -1
}
