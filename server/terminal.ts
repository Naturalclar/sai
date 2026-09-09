// 返信を、セッションが開いている tmux のペインに打ち込む。
//
//   POST /reply → ペインとセッション本体（pid）が今も対応しているか → 入力欄が空でダイアログ中でないか
//     → tmux load-buffer（本文）→ paste-buffer -p（bracketed paste。複数行そのまま）→ send-keys Enter
//
// 別プロセスを立てないので、返答は端末に出て、フックが普通のターンとして JSONL に足す。
// 「処理中」は子プロセスが無いので、since より新しいターン完了の行が届いたら解消（settle）。
import { spawn } from 'node:child_process'
import type { Agent, Replying, ReplyingMap, Terminal } from '../shared/types.ts'

/** ターン完了の行が届かないまま、これだけ経ったら諦めて「処理中」を消す */
export const TERMINAL_REPLY_TTL_MS = 30 * 60_000

/** pid が生きているか。EPERM は「いるが自分のものではない」なので生きている扱い */
export function alive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** ps の `pid ppid` 行を親子表にする */
export function parsePs(output: string): Map<number, number> {
  const parents = new Map<number, number>()
  for (const line of output.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (m) parents.set(Number(m[1]), Number(m[2]))
  }
  return parents
}

/** pid が ancestor の子孫（または本人）か */
export function isDescendant(pid: number, ancestor: number, parents: Map<number, number>): boolean {
  let cur: number | undefined = pid
  for (let i = 0; i < 64 && cur !== undefined; i++) {
    if (cur === ancestor) return true
    cur = parents.get(cur)
  }
  return false
}

/** 打ち込めない理由の種類。typed だけは人の確認のうえで消して打ち込める（#117） */
export type PromptKind = 'idle' | 'typed' | 'dialog' | 'unknown'

export interface PromptState {
  /** 打ち込んでよいか */
  idle: boolean
  kind: PromptKind
  /** だめな理由（画面の 409 に出す） */
  reason: string
  /** kind が typed のとき、入力欄に見えている文（1 行ぶん） */
  typed: string
  /** スラッシュコマンドの候補メニューが開いている（`/` で始めると入力欄の下に並ぶ）。消す前に Escape で閉じる */
  menu?: boolean
}

const DIALOG = /Enter to (?:confirm|select|submit)|Esc to cancel|Press enter to continue|Waiting for user input/i

/** 空の入力欄に出る placeholder。打ちかけではない。文言は CLI の版で変わりうるので、見つけたら足す */
const PLACEHOLDER: Record<'claude' | 'codex' | 'opencode', RegExp> = {
  claude: /^Try ["\u201c]|^Try /,
  codex: /^Ask Codex to do anything/,
  opencode: /^Ask anything/,
}
/** OpenCode の入力欄。箱の各行が `┃` で始まり、最後の `┃` 行はモードとモデル（`Build · GPT-5.6 …`）。1.18.30 で確認 */
const OPENCODE_LINE = /^\s*┃[\s\u00a0]?(.*)$/
const OPENCODE_STATUS = /\s·\s/
/** 入力欄の箱の下の枠線（`╹▀▀▀…`）。会話の履歴も `┃` を使うので、ここから上に辿って箱だけを取る */
const OPENCODE_BORDER = /^\s*╹?[▀▔]{3,}/
/** 箱の右側にはパスなどの別の列が同じ行に描かれる。3 つ以上の空白で切って左（入力欄）だけを読む */
const OPENCODE_GAP = /\s{3,}/
/** 入力欄の続きの行ではないもの（区切り線、状態行、モデル名の行）。ここで打ちかけの続きを読むのを止める */
const NOT_INPUT = /^\s*(⏵⏵|─|╰|╭|\? for shortcuts|\S+ (minimal|low|medium|high|xhigh) ·)/
/** 打ちかけを消すために送る C-u の上限。1 回で 1 行しか消えないので行数ぶん要る */
export const MAX_CLEAR_KEYS = 20
/** C-u のあと画面が変わっていないとき、描き直しの遅れを疑って capture-pane をやり直す回数 */
export const CLEAR_RECAPTURES = 3
/** 区切り線（Claude Code は入力欄の上下に `──…` を引く）。入力欄はその直上の行 */
const SEPARATOR = /^\s*─{3,}/
/** スラッシュコマンドの候補メニューの行（`❯ /issue-triage   説明` / `  /clear   説明`）。入力欄の下に並ぶ */
const MENU_ROW = /^\s*(?:❯[\s\u00a0]*)?\/[\w:-]+(?:\s{2,}\S.*)?$/

/**
 * ペインの画面（capture-pane の末尾）から、いま打ち込んでよいかを決める。
 * - 「Enter to confirm」「Esc to cancel」「Press enter to continue」があれば許可ダイアログや質問の最中（打ち込むと答えになってしまう）。
 *   `❯ 1. Yes` のように番号付きの選択肢が入力欄の位置に見えていてもダイアログ（Codex の信頼確認など）
 * - 入力欄（Claude Code は `❯`、Codex は `›` か `>`）に打ちかけの文字があれば混ぜない。
 *   Claude Code は空のとき `Try "refactor <filepath>"` のような薄い placeholder を出すので、それは空扱い
 * 入力欄が見つからないときは「分からない」ので止める（別のプログラムに打ち込まない）
 */
export function promptState(screen: string, agent: Agent): PromptState {
  // capture-pane は画面下の空行もそのまま返すので、空行を除いてから末尾を見る
  const lines = screen
    .split('\n')
    .map((l) => l.replace(/[\s\u00a0]+$/, ''))
    .filter((l) => l.trim())
  const tail = lines.slice(-25).join('\n')
  const dialog: PromptState = { idle: false, kind: 'dialog', reason: '端末が許可や質問のダイアログを出している', typed: '' }
  if (DIALOG.test(tail)) return dialog
  // OpenCode は箱の形が違い、空行も箱の一部なので、空行を落とす前の画面から読む
  if (agent === 'opencode') return opencodePrompt(screen.split('\n').map((l) => l.replace(/[\s\u00a0]+$/, '')))
  // 入力欄の行。Claude Code は `❯` の後ろが NBSP（\u00a0）。ダイアログの選択肢（`  ❯ 1. Yes`）は上の検査で先に弾いている
  const markers = agent === 'codex' ? /^\s*[›>][\s\u00a0]?(.*)$/ : /^\s*(?:│\s*)?❯[\s\u00a0]?(.*)$/
  const placeholder = agent === 'codex' ? PLACEHOLDER.codex : PLACEHOLDER.claude
  const from = Math.max(0, lines.length - 25)
  // Claude Code は入力欄の直下に区切り線を引く。スラッシュコマンドの候補メニュー（`❯ /issue-triage  説明`）の
  // 選択行にも ❯ が付くので、「一番下の ❯」ではなく「入力欄（区切り線の直上）」を優先して探す。
  // 区切り線が無い画面（古い版、Codex）は今までどおり一番下の ❯ / ›
  let at = -1
  const hasSeparator = agent !== 'codex' && lines.slice(from).some((l) => SEPARATOR.test(l))
  for (let i = lines.length - 1; i >= from; i--) {
    if (!markers.test(lines[i]!)) continue
    if (!hasSeparator) {
      at = i
      break
    }
    // 直下（複数行の打ちかけならその続きの下）が区切り線なら入力欄
    let j = i + 1
    while (j < lines.length && /^ {2}\S/.test(lines[j]!) && !NOT_INPUT.test(lines[j]!)) j++
    if (j < lines.length && SEPARATOR.test(lines[j]!)) {
      at = i
      break
    }
    if (at < 0) at = i // 区切り線の直上に見つからなければ一番下の ❯ に落ちる
  }
  if (at >= 0) {
    const m = lines[at]!.match(markers)!
    const first = (m[1] ?? '').trim()
    if (!first || placeholder.test(first)) return { idle: true, kind: 'idle', reason: '', typed: '' }
    if (/^\d+\.\s/.test(first)) return dialog
    // 複数行の打ちかけは、続きの行が 2 文字下げで並ぶ（Claude Code も Codex も同じ）。区切り線や状態行の手前まで
    const rest: string[] = []
    let j = at + 1
    for (; j < lines.length; j++) {
      const l = lines[j]!
      if (!/^ {2}\S/.test(l) || NOT_INPUT.test(l)) break
      rest.push(l.trim())
    }
    const typed = [first, ...rest].join('\n')
    const state: PromptState = { idle: false, kind: 'typed', reason: `端末の入力欄に打ちかけの文字がある: ${first.slice(0, 40)}`, typed }
    // `/` で始めていて、入力欄の下（区切り線の下）に候補の行が並んでいればメニューが開いている
    if (first.startsWith('/') && lines.slice(j).some((l) => MENU_ROW.test(l))) state.menu = true
    return state
  }
  return { idle: false, kind: 'unknown', reason: '端末の入力欄が見つからない（セッションが動いていない、または画面が違う）', typed: '' }
}

/**
 * OpenCode の入力欄（1.18.30 で確認）。他の CLI（`❯` / `›` の 1 行 + 2 文字下げの続き）と形が違い、
 * **箱の各行が `┃`**、その下に枠線（`╹▀▀▀…`）が引かれる。会話の履歴も `┃` を使うので、
 * 「一番下の枠線のすぐ上にある `┃` の連なり」だけを箱として読む（空行も箱の一部なので、空行は落とさずに渡す）。
 *
 * 箱の最後の行はモードとモデル（`Build · Qwen3 8B Ollama`）。それを落として上下の空行を落とした残りが打ちかけ。
 * 箱の右側には作業ディレクトリのパスが同じ行に描かれるので、空白が 3 つ以上続いたらそこから右は捨てる。
 * 新しいセッションは placeholder（`Ask anything…`）が出るが、**1 ターン回した後は何も出ない**ので、空の箱は空扱い。
 */
function opencodePrompt(raw: string[]): PromptState {
  const unknown = (reason: string): PromptState => ({ idle: false, kind: 'unknown', reason, typed: '' })
  let border = -1
  for (let i = raw.length - 1; i >= 0; i--) {
    if (OPENCODE_BORDER.test(raw[i]!)) {
      border = i
      break
    }
  }
  if (border < 0) return unknown('端末の入力欄が見つからない（セッションが動いていない、または画面が違う）')
  const box: string[] = []
  for (let i = border - 1; i >= 0; i--) {
    const m = raw[i]!.match(OPENCODE_LINE)
    if (!m) break
    // 右側の列（作業ディレクトリのパスなど）を落とす。入力欄との間は空白が続くので、そこで切る
    box.unshift((m[1] ?? '').split(OPENCODE_GAP)[0]!.trim())
  }
  if (box.length === 0) return unknown('端末の入力欄が見つからない（枠線の上に入力欄が無い）')
  // 最後の行はモード・モデル。形が違えば落とさない（打ちかけとして残す = 打ち込まない側に倒す）
  const body = OPENCODE_STATUS.test(box[box.length - 1] ?? '') ? box.slice(0, -1) : box
  while (body.length && !body[0]) body.shift()
  while (body.length && !body[body.length - 1]) body.pop()
  const first = body[0] ?? ''
  if (!body.length || PLACEHOLDER.opencode.test(first)) return { idle: true, kind: 'idle', reason: '', typed: '' }
  return { idle: false, kind: 'typed', reason: `端末の入力欄に打ちかけの文字がある: ${first.slice(0, 40)}`, typed: body.join('\n') }
}

/** tmux を叩く口。テストでは差し替える */
export interface Tmux {
  /** stdout を返す。失敗（ペインが無い、tmux が無い）は reject */
  run(args: string[], input?: string): Promise<string>
}

export class RealTmux implements Tmux {
  readonly bin: string
  constructor(bin: string = process.env.SAI_TMUX_BIN || 'tmux') {
    this.bin = bin
  }
  run(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (c: Buffer) => (out += c.toString()))
      child.stderr.on('data', (c: Buffer) => (err += c.toString()))
      child.once('error', reject)
      child.once('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `tmux exited ${code}`))))
      if (input !== undefined) child.stdin.end(input)
      else child.stdin.end()
    })
  }
}

/** ps を叩く口。テストでは差し替える */
export type PsFn = () => Promise<string>

export const realPs: PsFn = () =>
  new Promise((resolve, reject) => {
    const child = spawn('ps', ['-axo', 'pid=,ppid='], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString()))
    child.once('error', reject)
    child.once('close', () => resolve(out))
  })

/** 入力中・ダイアログ中で打ち込めない。kind と typed は 409 の body に載せ、画面が「消して送る」を出すかを決める */
export class TerminalBusy extends Error {
  readonly kind: Exclude<PromptKind, 'idle'>
  readonly typed: string
  constructor(state: PromptState) {
    super(state.reason)
    this.kind = state.kind === 'idle' ? 'unknown' : state.kind
    this.typed = state.typed
  }
}
export class TerminalGone extends Error {}

/**
 * ペインが今も同じセッションのものか確かめて、現在の入力状態を読む。
 * 能動監視でも返信直前と同じ所有者確認を通し、別のプロセスの画面を誤って表示しない。
 */
export async function inspectPrompt(tmux: Tmux, ps: PsFn, terminal: Terminal, agent: Agent): Promise<PromptState> {
  let panePid = 0
  try {
    panePid = Number((await tmux.run(['display-message', '-p', '-t', terminal.pane, '#{pane_pid}'])).trim())
  } catch (err) {
    throw new TerminalGone(`ペイン ${terminal.pane} が無い: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!panePid) throw new TerminalGone(`ペイン ${terminal.pane} の pid が取れない`)
  if (!isDescendant(terminal.pid, panePid, parsePs(await ps()))) throw new TerminalGone(`ペイン ${terminal.pane} で動いているのは別のプロセス`)
  return promptState(await tmux.run(['capture-pane', '-p', '-t', terminal.pane]), agent)
}

export interface TypeOptions {
  /** 入力欄の打ちかけを消してから打ち込んでよい（人が確認済み）。ダイアログ中・入力欄不明には効かない */
  replaceTyped?: boolean
  /** 消すキーを送ってから画面を描き直すまでの待ち。テストは 0 */
  settleMs?: number
}

export interface TypeResult {
  /** 打ちかけを消してから打ち込んだなら、消した文（reply.log に残す。戻せないので） */
  cleared?: string
}

/** 消すキーを送ったあと、画面が描き直るのを待つ既定 */
const SETTLE_MS = 150

/**
 * ペインに打ち込む。
 * - TerminalGone: ペインが無い、または pid がそのペインの子孫ではない（フォールバックして -p で回す）
 * - TerminalBusy: 入力中・ダイアログ中（409。何も打ち込まない）
 * - replaceTyped のときだけ、打ちかけ（kind: typed）を C-u で消してから打つ。C-u は Claude Code も Codex も
 *   **いまの行しか消さない**。消したあとカーソルは空になった行に残るので、BSpace でその行の改行を消して前の行末に
 *   戻してから、次の C-u を送る。空になるまで繰り返す（上限 MAX_CLEAR_KEYS。画面が変わらなくなったら止める）。
 *   1 行のときは C-u で空になり、空の入力欄への BSpace は何もしない（実機で確認）。
 *   消したあとにもう一度 capture-pane して本当に空になったときだけ貼る（キーが効かない端末で文を混ぜない）。
 *   最後に消した 1 行は「Ctrl+Y to paste deleted text」で戻せるが、複数行は戻せないので消した全文を返す（reply.log に残す）
 */
export async function typeInto(tmux: Tmux, ps: PsFn, terminal: Terminal, agent: Agent, text: string, options: TypeOptions = {}): Promise<TypeResult> {
  let panePid = 0
  try {
    panePid = Number((await tmux.run(['display-message', '-p', '-t', terminal.pane, '#{pane_pid}'])).trim())
  } catch (err) {
    throw new TerminalGone(`ペイン ${terminal.pane} が無い: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!panePid) throw new TerminalGone(`ペイン ${terminal.pane} の pid が取れない`)
  if (!isDescendant(terminal.pid, panePid, parsePs(await ps()))) throw new TerminalGone(`ペイン ${terminal.pane} で動いているのは別のプロセス`)
  const capture = async () => promptState(await tmux.run(['capture-pane', '-p', '-t', terminal.pane]), agent)
  let state = await capture()
  const result: TypeResult = {}
  if (state.kind === 'typed' && options.replaceTyped) {
    const cleared = state.typed
    const settle = options.settleMs ?? SETTLE_MS
    const wait = () => (settle > 0 ? new Promise((r) => setTimeout(r, settle)) : Promise.resolve())
    // スラッシュコマンドの候補メニューが開いていると C-u がメニューに食われることがあるので、先に Escape で閉じる
    if (state.menu) {
      await tmux.run(['send-keys', '-t', terminal.pane, 'Escape'])
      await wait()
      state = await capture()
    }
    for (let n = 0; n < MAX_CLEAR_KEYS && state.kind === 'typed'; n++) {
      const before = state.typed
      // C-u: いまの行を消す。BSpace: 空になった行の改行を消して前の行末へ（1 行なら何も起きない）
      await tmux.run(['send-keys', '-t', terminal.pane, 'C-u', 'BSpace'])
      await wait()
      state = await capture()
      // 画面が変わらないときは描き直しの遅れかもしれないので、少し待って何回か見直す。
      // それでも同じなら、このキーでは消せない端末。繰り返しても同じなので止める
      let same = state.kind === 'typed' && state.typed === before
      for (let k = 0; same && k < CLEAR_RECAPTURES; k++) {
        await wait()
        state = await capture()
        same = state.kind === 'typed' && state.typed === before
      }
      if (same) break
    }
    if (state.idle) result.cleared = cleared
  }
  if (!state.idle) throw new TerminalBusy(state)
  const buffer = `sai-${process.pid}-${Date.now()}`
  await tmux.run(['load-buffer', '-b', buffer, '-'], text)
  try {
    await tmux.run(['paste-buffer', '-p', '-d', '-b', buffer, '-t', terminal.pane])
  } catch (err) {
    await tmux.run(['delete-buffer', '-b', buffer]).catch(() => {})
    throw err
  }
  await tmux.run(['send-keys', '-t', terminal.pane, 'Enter'])
  return result
}

/**
 * 端末に打ち込んだ返信の「処理中」。子プロセスが無いので、ターン完了の行が since より新しくなったら終わり。
 * サーバを再起動すると忘れるが、端末側のターンは止まらないので実害は「処理中」の表示が消えるだけ
 */
export class TerminalReplies {
  private active = new Map<string, Replying>()
  private readonly now: () => number
  constructor(now: () => number = Date.now) {
    this.now = now
  }
  running(id: string): boolean {
    return this.active.has(id)
  }
  snapshot(): ReplyingMap {
    return Object.fromEntries(this.active)
  }
  start(id: string, text: string): Replying {
    // via で「端末に打ち込んだ返信」だと分かるようにする（#232。要対応の出し分けが使う）
    const entry: Replying = { since: new Date(this.now()).toISOString(), text, via: 'terminal' }
    this.active.set(id, entry)
    return entry
  }
  /** lastTurn(id) がその返信より新しければ終わり。TTL を超えたものも消す */
  settle(lastTurn: (id: string) => string | undefined): void {
    for (const [id, r] of this.active) {
      const turn = lastTurn(id)
      // 行の ts は秒までなので、since も秒に丸めて比べる（同じ秒に届いたターンも「後」とみなす）
      const since = Math.floor(Date.parse(r.since) / 1000) * 1000
      if ((turn && Date.parse(turn) >= since) || this.now() - since > TERMINAL_REPLY_TTL_MS) this.active.delete(id)
    }
  }
}
