// 端末で開いている Codex が出している許可・質問のダイアログを、tmux の画面から読む（#425）。
//
// `notify` はターン完了でしか鳴らず、通常起動の TUI からは app-server の server request も購読できないので、
// **何を聞かれているかは画面にしか無い**。`promptState()` はその画面を `kind: 'dialog'` の判定にだけ使って
// 捨てていたので、SAI 側には「待っている」の 1 行しか出ていなかった。
//
// **読んだ中身は、画面から答えるのにも使う**（#450）。押された選択肢まで印（`›`）を動かして `Enter` を送るが、
// **送る前と後に画面を読み直して、同じダイアログのままか・消えたかを確かめる**（誤って別の許可を押さないため。#208）。
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
//
// **選択肢が画面の幅で折り返すと、続きは番号のぶん深い 5 文字下げになる**（#595。幅 272 文字のペインで実測）:
//
//     2. Yes, and don't ask again for commands that start with `gh pr create --base main … 場合
//        より先に配送確認を実施\n- ターン完了またはエラー時には…  `git
//        diff --check`'` (p)
//     3. No, and tell Codex what to do differently (esc)
//
// 2 番は `<コマンド全文>` を抱えるので、コマンドが長いと必ずこうなる。深い字下げの行も辿らないと、
// 塊が `3.` の 1 行だけになり、「No」しか出ない・印が読めないので押せもしない、になる。
import type { ApprovalDecision, TerminalDialog, TerminalDialogOption } from './types.ts'

/** ダイアログの終わりの行。`server/reply/terminal.ts` の DIALOG（検出）と同じ言い回し */
const FOOTER = /Enter to (?:confirm|select|submit)|Esc to cancel|Press enter to continue|Waiting for user input/i
/** 選択肢の行（印と字下げを落としたあと） */
const OPTION = /^(\d+)\.\s+(.*)$/
/** 行の頭の選択の印 */
const MARKER = /^[›❯>][\s\u00a0]?/
/** ダイアログの本文の字下げ（2 文字） */
const INDENT = /^ {2}\S/
/** 折り返した選択肢・複数行のコマンドの続き（3 文字以上の字下げ）。会話の側のツールの出力（`    … +3 lines`）も同じ形 */
const DEEP = /^ {3,}\S/
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
  let end = footer >= 0 ? footer - 1 : lastOption
  if (end < 0 || lastOption < 0 || lastOption > end) return null
  // **最後の選択肢が折り返している**と、塊の最後の行は深い字下げの続きになる（#597 のレビュー）。
  // 終わりの行が無いときは、最後の選択肢の下の続きまでを塊に入れる（入れないとラベルが途中で切れる）
  if (footer < 0) while (end + 1 < lines.length && DEEP.test(lines[end + 1]!)) end++
  if (!isDialogLine(lines[end]!) && !DEEP.test(lines[end]!)) return null
  // 深い字下げの行も辿る（#595。折り返した選択肢の続きで止めると、その下の選択肢しか残らない）
  let start = end
  while (start > 0 && (isDialogLine(lines[start - 1]!) || DEEP.test(lines[start - 1]!)) && !isBoxLine(lines[start - 1]!)) start--
  const block = lines.slice(headStart(lines.slice(start, end + 1)) + start, end + 1)

  const head: string[] = []
  const command: string[] = []
  const options: TerminalDialogOption[] = []
  for (const line of block) {
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
 * 辿った塊のうち、ダイアログが始まる位置。**深い字下げが続きになるのは `$` のコマンドと選択肢の下だけ**で、
 * 見出し・説明は 2 文字下げで折り返す。そこより上にある深い字下げの行は会話の側のツールの出力
 * （`    … +3 lines`）なので、その下から読む（巻き込むと出力の 1 行が見出しになる）
 */
function headStart(block: readonly string[]): number {
  const firstOption = block.findIndex(isOption)
  const command = block.findIndex((l, i) => i < firstOption && bodyOf(l).body.startsWith('$ '))
  const headEnd = command >= 0 ? command : firstOption
  let from = 0
  for (let i = 0; i < headEnd; i++) if (DEEP.test(block[i]!)) from = i + 1
  return from
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

// ---- 画面から答える（#450） ----

/**
 * **範囲が読めたときだけ押せるようにする選択肢**（`2. Yes, and don't ask again for commands that start with …`。#741）。
 * 押すと Codex が「その語で始まるコマンドを今後聞かない」規則を自分で足す（SAI は書かない）。
 * 前は一律に落としていた（効く範囲がボタンの文字から読み切れない。#421 で OpenCode の `always` を出さなかったのと同じ理由）。
 * いまは `dontAskScope()` が**範囲を全部読めたときだけ**、その範囲をボタンに書いて出す。読めなければ今までどおり落とす（端末でなら押せる）
 */
const ALWAYS_OPTION = /don'?t ask again|always (?:allow|approve)/i
/**
 * 範囲を読める形。**文の終わり（閉じる引用符と近道キー `(p)`）まで辿れていること**を形で確かめる
 * （折り返しの途中までしか読めていなければ、最後が `` ` (p) `` にならない）。範囲そのものに引用符が入ることがあるので、
 * 閉じるのは最後の引用符
 */
const DONT_ASK = /^Yes, and don't ask again for commands that start with `(.+)` \(p\)$/
/** ボタンに書ける範囲の長さ。これより長いものは、押す人が読み切れないので出さない */
export const DONT_ASK_SCOPE_MAX = 120

const squash = (text: string): string => text.trim().replace(/\s+/g, ' ')

/**
 * 「今後も聞かない」が効く範囲（**その語で始まるコマンド**の「その語」）。**全部読めたときだけ**返し、少しでも怪しければ null（#741）:
 *
 * - その選択肢がちょうど 1 つで、文が終わり（閉じる引用符と `(p)`）まで読めている
 * - 幅や長さで切れていない（`…` が入っていない。`MAX_LABEL` で切ったものも `…` が付く）
 * - **読めた範囲が、見出しのコマンド（`$ …`）の頭と語の区切りで一致する**（別のコマンドの規則・ネットワークの規則のような別の形の文、
 *   折り返しが語の途中に入って空白が紛れたもの、をここで落とす）
 * - 1 行で、ボタンに書ける長さ（`DONT_ASK_SCOPE_MAX`）に収まる
 *
 * **範囲が広すぎるか（`sudo` や `rm` の 1 語など）は見ない**: 範囲をそのままボタンに書いて、押すかは人が決める
 */
export function dontAskScope(dialog: TerminalDialog | null): { option: TerminalDialogOption; scope: string } | null {
  if (!dialog) return null
  const always = dialog.options.filter((o) => ALWAYS_OPTION.test(o.label))
  if (always.length !== 1) return null
  const option = always[0]!
  if (option.label.includes('…')) return null
  const scope = DONT_ASK.exec(option.label)?.[1]
  if (!scope || scope !== scope.trim() || /\s{2,}/.test(scope) || scope.length > DONT_ASK_SCOPE_MAX) return null
  // コマンドが複数行のときは、範囲と字面を突き合わせられない（改行の出方が違う）
  if (!dialog.command.trim() || dialog.command.trim().includes('\n')) return null
  const command = squash(dialog.command)
  if (command !== scope && !command.startsWith(`${scope} `)) return null
  return { option, scope }
}

/** 「今後も聞かない」のボタンの文言。**範囲そのもの**を書く（「常に許可」とだけ書かない。押した範囲が本人に見えるように） */
export const dontAskLabel = (scope: string): string => `\`${scope}\` で始まるコマンドを今後聞かない`
/** 「はい」ではない選択肢（ボタンの色と `behavior` を決めるだけ） */
const DENY_OPTION = /^(?:no\b|don'?t\b|reject|cancel|いいえ)/i

/** 決定の id（`opt-3`）。画面へ渡すのはこれで、**サーバは提示したものだけを受け付ける** */
export const dialogDecisionId = (option: Pick<TerminalDialogOption, 'number'>): string => `opt-${option.number}`

/**
 * 画面に出す選択肢（#450）。**「今後も聞かない」は、範囲が全部読めたときだけ出す**（#741。`dontAskScope()`）。読めなければ落とすので、
 * ダイアログに 3 つあっても 2 つになる。ラベルは画面に出ている英語のまま（Codex 自身の言い回し。許可モードの名前を英語のままに
 * しているのと同じ）で、「今後も聞かない」だけは範囲を書いた文にする（`dontAskLabel()`）。並びはダイアログのまま
 */
export function dialogDecisions(dialog: TerminalDialog | null): ApprovalDecision[] {
  if (!dialog) return []
  const dontAsk = dontAskScope(dialog)
  return dialog.options
    .filter((o) => !ALWAYS_OPTION.test(o.label) || o === dontAsk?.option)
    .map((o) => ({
      id: dialogDecisionId(o),
      label: o === dontAsk?.option ? dontAskLabel(dontAsk.scope) : o.label,
      behavior: DENY_OPTION.test(o.label) ? ('deny' as const) : ('allow' as const),
    }))
}

/**
 * 読めた中身が**答えられる形か**（#595）。半分しか読めなかったものに答えさせない:
 *
 * - 番号が 1 から続いていない（頭が欠けた。塊は下から辿るので、欠けるのはいつも上）
 * - 印（`›`）の付いた選択肢がちょうど 1 つでない（どこから矢印を送ればよいか分からない）
 * - 選択肢が 1 つしか無い、「はい」に当たるものが 1 つも残らない（選ばせる形になっていない）
 *
 * 当たったら `Approval.answerable` を false にして、ボタンを出さない（押しても `409` になるだけなので）
 */
export function dialogAnswerable(dialog: TerminalDialog | null): boolean {
  if (!dialog || dialog.options.length < 2) return false
  if (!dialog.options.every((o, i) => o.number === i + 1)) return false
  if (dialog.options.filter((o) => o.selected).length !== 1) return false
  return dialogDecisions(dialog).some((d) => d.behavior === 'allow')
}

/**
 * 押された決定が**いまのダイアログの選択肢か**。`behavior` も突き合わせる
 * （画面のボタンと中身が食い違っていれば受けない）。返すのは並びの位置（0 始まり）
 */
export function dialogDecisionIndex(dialog: TerminalDialog | null, decision: string | undefined, behavior: 'allow' | 'deny'): number | null {
  if (!dialog || !decision) return null
  const allowed = dialogDecisions(dialog)
  const hit = allowed.find((d) => d.id === decision)
  if (!hit || hit.behavior !== behavior) return null
  const index = dialog.options.findIndex((o) => dialogDecisionId(o) === decision)
  return index >= 0 ? index : null
}

/** いま印（`›`）が付いている選択肢の位置。1 つも付いていなければ null（読めていない＝動かさない） */
export function selectedIndex(dialog: TerminalDialog | null): number | null {
  if (!dialog) return null
  const index = dialog.options.findIndex((o) => o.selected)
  return index >= 0 ? index : null
}

/**
 * 狙った選択肢まで印を動かすキー（#450）。**番号キーは使わない**（実機で `1` を送っても確定も移動もしなかった。
 * 効いたのは矢印で動かして `Enter`）。同じ位置なら何も送らない
 */
export function dialogSteps(dialog: TerminalDialog | null, targetIndex: number): { key: 'Down' | 'Up'; count: number } | null {
  const from = selectedIndex(dialog)
  if (from === null || targetIndex < 0 || targetIndex >= (dialog?.options.length ?? 0)) return null
  const diff = targetIndex - from
  return { key: diff >= 0 ? 'Down' : 'Up', count: Math.abs(diff) }
}
