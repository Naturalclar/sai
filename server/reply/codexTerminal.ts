// 記録した pid が死んでいる Codex のセッションを、thread writer lock を握っている生きたプロセスから引き直す（#332 の案 2）。
//
// `record.py` は Codex の pid を親から辿るようになった（#335）が、**それより前に書かれた行は notify の
// ラッパー（すぐ終わるシェル）の pid**を持っている。pid が死んでいると `terminalOf()` が null を返すので、
// ペインでは Codex が動いているのに SAI からは「端末で開いていない」ままになり、
// 画面の許可待ち（`CodexDialogs`）にも端末への打ち込みにも回らない。
import { execFile } from 'node:child_process'
import { codexWriterLockHolders, lsofHolders, type LockHolders } from './codex.ts'
import { isDescendant } from './terminal.ts'
import type { PsRow } from './codexPanes.ts'

/** 引き直した結果を覚えておく長さ。3 秒のポーリングのたびに `lsof` を起こさないため（見つからなかったことも覚える） */
export const CODEX_PID_TTL_MS = 30_000

export interface CodexTerminalSource {
  /** そのセッションを、そのペインで実際に握っている生きたプロセスの pid。引けなければ 0 */
  pid(session: string, pane: string): Promise<number>
  /** 前回の結果（`lsof` を起こさない。#495 の締切で使う）。知らなければ 0。偽物は持たなくてよい */
  last?(session: string, pane: string): number
  /**
   * 行の pid（生きている）が、そのペインの端末として使えるか（#562）。ペインの中ならその pid、
   * ペインの外（共有の `codex app-server --listen`）なら**そのペインの中でその pid に繋いでいる codex** の pid、
   * どちらでもなければ 0。無ければ（テストの偽物）今までどおり行の pid をそのまま使う
   */
  owner?(pane: string, pid: number): Promise<number>
  /** `owner()` の前回の結果。知らなければ undefined（#495 の締切で使う） */
  lastOwner?(pane: string, pid: number): number | undefined
}

/** `lsof -a -U -p <pid> -F dn` の出力。自分の unix ソケットの番地（`d`）と、繋がっている相手の番地（`n->`） */
export function parseUnixSockets(output: string): { addrs: Set<string>; peers: Set<string> } {
  const addrs = new Set<string>()
  const peers = new Set<string>()
  for (const line of output.split('\n')) {
    if (/^d0x[0-9a-f]+$/i.test(line)) addrs.add(line.slice(1).toLowerCase())
    const peer = line.match(/^n->(0x[0-9a-f]+)$/i)
    if (peer) peers.add(peer[1]!.toLowerCase())
  }
  return { addrs, peers }
}

/** `client` のソケットのどれかが `server` のソケットに繋がっているか */
export function isClientOf(client: string, server: string): boolean {
  const { addrs } = parseUnixSockets(server)
  for (const peer of parseUnixSockets(client).peers) if (addrs.has(peer)) return true
  return false
}

/** `lsof` で unix ソケットを読む口。読めなければ空（テストが差し替える） */
export type UnixSocketsRun = (pid: number) => Promise<string>

export const runUnixSockets: UnixSocketsRun = (pid) =>
  new Promise((resolve) => {
    execFile('lsof', ['-a', '-U', '-p', String(pid), '-F', 'dn'], { timeout: 5_000 }, (_err, stdout) => resolve(String(stdout ?? '')))
  })

/**
 * そのペイン（シェルの pid が `panePid`）の中の `codex` のうち、`server` に unix ソケットで繋いでいるもの（#562）。
 * **codex 0.153 の TUI は共有の `codex app-server --listen unix://` の客**で、ターンを回して rollout を書き notify を
 * 鳴らすのは app-server の方なので、行の pid はペインの外になる。見つからなければ 0
 */
export async function paneClientOf(server: number, panePid: number, rows: readonly PsRow[], sockets: UnixSocketsRun): Promise<number> {
  const parents = new Map(rows.map((r) => [r.pid, r.ppid]))
  const candidates = rows.filter((r) => r.comm === 'codex' && r.pid !== server && isDescendant(r.pid, panePid, parents))
  if (!candidates.length) return 0
  const serverOut = await sockets(server)
  if (!serverOut) return 0
  for (const c of candidates) if (isClientOf(await sockets(c.pid), serverOut)) return c.pid
  return 0
}

export interface CodexTerminalDeps {
  holders?: LockHolders
  alive?: (pid: number) => boolean
  /** その pid がそのペインの中で動いているか（tmux のペインの子孫か）。既定は「確かめられない」= false */
  inPane?: (pane: string, pid: number) => Promise<boolean>
  /** そのペインの中で `server` に繋いでいる codex の pid（#562。既定は「確かめられない」= 0） */
  paneClient?: (pane: string, server: number) => Promise<number>
  now?: () => number
  env?: NodeJS.ProcessEnv
}

/**
 * **lock を握っているのはそのセッションを開いている本人**（lock はセッション ID ごとのファイル）なので、
 * 同じペインで別の Codex を起動し直していても取り違えない。
 *
 * **ただし「本人」が tmux の外にいることがある**（実測: ChatGPT アプリの `codex app-server --listen` が
 * そのスレッドの lock を握っていた。ppid は 1 で、どのペインの子孫でもない）。行の `pane` と並べて
 * 「端末で開いている」と答えてしまわないよう、**そのペインの子孫かまで確かめてから**返す。
 *
 * **`lsof` が使えないときは 0**（= 今までどおり端末扱いにしない）。`codexWriterActive()` は同じ材料で
 * 「開いている扱い」に倒すが、あちらは**閉じたセッションに queue を渡さない**ための判定で、こちらは
 * **打ち込む先を決める**判定なので、分からないときに倒す向きが逆になる。
 */
export class CodexTerminals implements CodexTerminalSource {
  private cache = new Map<string, { at: number; pid: number }>()
  /** 引き直しの最中（同じ鍵で `lsof` を重ねない。3 秒のポーリングが締切で抜けたあとも走っている） */
  private inflight = new Map<string, Promise<number>>()
  private readonly holders: LockHolders
  private readonly alive: (pid: number) => boolean
  private readonly inPane: (pane: string, pid: number) => Promise<boolean>
  private readonly paneClient: (pane: string, server: number) => Promise<number>
  private readonly now: () => number
  private readonly env: NodeJS.ProcessEnv

  constructor(deps: CodexTerminalDeps = {}) {
    this.holders = deps.holders ?? lsofHolders
    this.alive = deps.alive ?? ((pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
    this.inPane = deps.inPane ?? (async () => false)
    this.paneClient = deps.paneClient ?? (async () => 0)
    this.now = deps.now ?? Date.now
    this.env = deps.env ?? process.env
  }

  /** 前回の結果。TTL が切れていてもそのまま。覚えている pid が死んでいれば 0 */
  last(session: string, pane: string): number {
    const hit = this.cache.get(`${session}\n${pane}`)
    return hit && (hit.pid === 0 || this.alive(hit.pid)) ? hit.pid : 0
  }

  async pid(session: string, pane: string): Promise<number> {
    const key = `${session}\n${pane}`
    const hit = this.cache.get(key)
    // 覚えている pid が死んでいたら、TTL の中でも引き直す（端末を閉じたのに「開いている」と言い続けない）
    if (hit && this.now() - hit.at < CODEX_PID_TTL_MS && (hit.pid === 0 || this.alive(hit.pid))) return hit.pid
    const running = this.inflight.get(key)
    if (running) return running
    const work = this.lookup(session, pane).finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, work)
    return work
  }

  /** `owner()` の前回の結果。TTL が切れていてもそのまま。知らなければ undefined */
  lastOwner(pane: string, pid: number): number | undefined {
    const hit = this.cache.get(`owner\n${pane}\n${pid}`)
    if (!hit) return undefined
    return hit.pid === 0 || this.alive(hit.pid) ? hit.pid : 0
  }

  async owner(pane: string, pid: number): Promise<number> {
    const key = `owner\n${pane}\n${pid}`
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < CODEX_PID_TTL_MS && (hit.pid === 0 || this.alive(hit.pid))) return hit.pid
    const running = this.inflight.get(key)
    if (running) return running
    const work = this.lookupOwner(pane, pid)
      .then((found) => {
        this.cache.set(key, { at: this.now(), pid: found })
        return found
      })
      .finally(() => {
        this.inflight.delete(key)
      })
    this.inflight.set(key, work)
    return work
  }

  private async lookupOwner(pane: string, pid: number): Promise<number> {
    try {
      if (await this.inPane(pane, pid)) return pid
      // ペインの外（共有の app-server）。そのペインの TUI がその app-server の客なら、TUI を端末とみなす
      return await this.paneClient(pane, pid)
    } catch {
      return 0
    }
  }

  private async lookup(session: string, pane: string): Promise<number> {
    const key = `${session}\n${pane}`
    let pid = 0
    if (pane) {
      try {
        // 合成 ID・壊れた ID・lock が無いセッションは null。存在しない lock に lsof を起こさない（#432）。
        for (const candidate of (await codexWriterLockHolders(session, this.env, this.holders)) ?? []) {
          if (this.alive(candidate) && (await this.inPane(pane, candidate))) {
            pid = candidate
            break
          }
        }
      } catch {
        pid = 0
      }
    }
    this.cache.set(key, { at: this.now(), pid })
    return pid
  }
}
