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

export interface PromptState {
  /** 打ち込んでよいか */
  idle: boolean
  /** だめな理由（画面の 409 に出す） */
  reason: string
}

/**
 * ペインの画面（capture-pane の末尾）から、いま打ち込んでよいかを決める。
 * - 「Enter to confirm」「Esc to cancel」があれば許可ダイアログや質問の最中（打ち込むと答えになってしまう）
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
  if (/Enter to confirm|Esc to cancel/.test(tail)) return { idle: false, reason: '端末が許可や質問のダイアログを出している' }
  // 入力欄の行。Claude Code は `❯` の後ろが NBSP（\u00a0）。ダイアログの選択肢（`  ❯ 1. Yes`）は上の検査で先に弾いている
  const markers = agent === 'codex' ? /^\s*[›>][\s\u00a0]?(.*)$/ : /^\s*(?:│\s*)?❯[\s\u00a0]?(.*)$/
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 25; i--) {
    const m = lines[i]!.match(markers)
    if (!m) continue
    const typed = (m[1] ?? '').trim()
    if (!typed || /^Try "/.test(typed) || /^Try /.test(typed)) return { idle: true, reason: '' }
    return { idle: false, reason: `端末の入力欄に打ちかけの文字がある: ${typed.slice(0, 40)}` }
  }
  return { idle: false, reason: '端末の入力欄が見つからない（セッションが動いていない、または画面が違う）' }
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

export class TerminalBusy extends Error {}
export class TerminalGone extends Error {}

/**
 * ペインに打ち込む。
 * - TerminalGone: ペインが無い、または pid がそのペインの子孫ではない（フォールバックして -p で回す）
 * - TerminalBusy: 入力中・ダイアログ中（409。何も打ち込まない）
 */
export async function typeInto(tmux: Tmux, ps: PsFn, terminal: Terminal, agent: Agent, text: string): Promise<void> {
  let panePid = 0
  try {
    panePid = Number((await tmux.run(['display-message', '-p', '-t', terminal.pane, '#{pane_pid}'])).trim())
  } catch (err) {
    throw new TerminalGone(`ペイン ${terminal.pane} が無い: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!panePid) throw new TerminalGone(`ペイン ${terminal.pane} の pid が取れない`)
  if (!isDescendant(terminal.pid, panePid, parsePs(await ps()))) throw new TerminalGone(`ペイン ${terminal.pane} で動いているのは別のプロセス`)
  const screen = await tmux.run(['capture-pane', '-p', '-t', terminal.pane])
  const state = promptState(screen, agent)
  if (!state.idle) throw new TerminalBusy(state.reason)
  const buffer = `sai-${process.pid}-${Date.now()}`
  await tmux.run(['load-buffer', '-b', buffer, '-'], text)
  try {
    await tmux.run(['paste-buffer', '-p', '-d', '-b', buffer, '-t', terminal.pane])
  } catch (err) {
    await tmux.run(['delete-buffer', '-b', buffer]).catch(() => {})
    throw err
  }
  await tmux.run(['send-keys', '-t', terminal.pane, 'Enter'])
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
    const entry: Replying = { since: new Date(this.now()).toISOString(), text }
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
