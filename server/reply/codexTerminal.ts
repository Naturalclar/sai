// 記録した pid が死んでいる Codex のセッションを、thread writer lock を握っている生きたプロセスから引き直す（#332 の案 2）。
//
// `record.py` は Codex の pid を親から辿るようになった（#335）が、**それより前に書かれた行は notify の
// ラッパー（すぐ終わるシェル）の pid**を持っている。pid が死んでいると `terminalOf()` が null を返すので、
// ペインでは Codex が動いているのに SAI からは「端末で開いていない」ままになり、
// 画面の許可待ち（`CodexDialogs`）にも端末への打ち込みにも回らない。
import { codexWriterLockHolders, lsofHolders, type LockHolders } from './codex.ts'

/** 引き直した結果を覚えておく長さ。3 秒のポーリングのたびに `lsof` を起こさないため（見つからなかったことも覚える） */
export const CODEX_PID_TTL_MS = 30_000

export interface CodexTerminalSource {
  /** そのセッションを、そのペインで実際に握っている生きたプロセスの pid。引けなければ 0 */
  pid(session: string, pane: string): Promise<number>
}

export interface CodexTerminalDeps {
  holders?: LockHolders
  alive?: (pid: number) => boolean
  /** その pid がそのペインの中で動いているか（tmux のペインの子孫か）。既定は「確かめられない」= false */
  inPane?: (pane: string, pid: number) => Promise<boolean>
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
  private readonly holders: LockHolders
  private readonly alive: (pid: number) => boolean
  private readonly inPane: (pane: string, pid: number) => Promise<boolean>
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
    this.now = deps.now ?? Date.now
    this.env = deps.env ?? process.env
  }

  async pid(session: string, pane: string): Promise<number> {
    const key = `${session}\n${pane}`
    const hit = this.cache.get(key)
    // 覚えている pid が死んでいたら、TTL の中でも引き直す（端末を閉じたのに「開いている」と言い続けない）
    if (hit && this.now() - hit.at < CODEX_PID_TTL_MS && (hit.pid === 0 || this.alive(hit.pid))) return hit.pid
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
