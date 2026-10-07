// Claude のログイン（claude.ai の OAuth）が切れていないかを `claude auth status --json` から読む（#685）。
//
// 切れると SAI が起こす `claude` の仕事（返信・新しいセッション・口が claude の一言）が全部失敗するが、
// 画面には返信の失敗の末尾しか出ず、理由がログイン切れだとは分からなかった。
//
// `ClaudeAgents`（#418）/ `GhPr`（#211）と同じ作法で閉じてある:
//
// - 叩くのは `claude auth status --json` の 1 形だけ。**読むだけ**で、`login` / `logout` / `setup-token` は起こさない
//   （SAI からのログインは別の部品 `claudeLogin.ts`。#577）
// - `claude` が無い・古くてこのサブコマンドが無い・時間切れ・JSON が壊れている、のどれでも
//   **`undefined`（分からない）**で、画面には何も出さない（材料が無いのに「切れている」と言わない）
// - 終了コードは見ない（切れているときに非 0 で終わる版でも、stdout の JSON を読む）
// - 聞くのは起動時・Claude の返信が失敗したとき・画面の「確かめ直す」だけ。3 秒のポーリングには乗せない
// - 持つのは `loggedIn` と `authMethod` だけ。`email` / `orgName` などは読んだその場で捨てる（画面に渡さない）
import { spawn } from 'node:child_process'

/** 諦めるまで */
export const AUTH_TIMEOUT_MS = 5000
/** 聞き直さない時間。返信がまとめて失敗しても `claude` を 1 回しか起こさない */
export const AUTH_CACHE_MS = 5000

export interface ClaudeAuthState {
  loggedIn: boolean
  /** `claude.ai` / `apiKey` など。無ければ空 */
  method: string
}

/** ログインの状態を引く口。テストでは差し替える */
export interface ClaudeAuthReader {
  /** 聞き直す。**分からなければ `undefined`**（切れている = `loggedIn: false` と区別する） */
  check(): Promise<ClaudeAuthState | undefined>
  /** 前に聞いた結果（`claude` を起こさない）。1 度も聞けていなければ `undefined` */
  peek(): ClaudeAuthState | undefined
}

/** 聞かない実装（`createApp` の既定。テストとスクラッチのサーバが本物の `claude` を叩かない） */
export class NoClaudeAuth implements ClaudeAuthReader {
  check(): Promise<ClaudeAuthState | undefined> {
    return Promise.resolve(undefined)
  }
  peek(): ClaudeAuthState | undefined {
    return undefined
  }
}

/** `claude auth status --json` の出力を読む。**`loggedIn` が真偽値でなければ `undefined`**（分からない） */
export function parseAuthStatus(stdout: string): ClaudeAuthState | undefined {
  let obj: unknown
  try {
    obj = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined
  const o = obj as Record<string, unknown>
  if (typeof o.loggedIn !== 'boolean') return undefined
  return { loggedIn: o.loggedIn, method: typeof o.authMethod === 'string' ? o.authMethod : '' }
}

export class ClaudeAuth implements ClaudeAuthReader {
  readonly bin: string
  private readonly ttl: number
  private readonly timeout: number
  private readonly now: () => number
  private at = 0
  private state: ClaudeAuthState | undefined
  /** 走っている 1 本。返る前に来た呼び出しはこれを待つ */
  private asking: Promise<ClaudeAuthState | undefined> | null = null
  /** 走っている聞き直し（`refresh()`）。同時に来た呼び出しで分け合う */
  private fresh: Promise<ClaudeAuthState | undefined> | null = null
  /** 走っている聞き直しが終わったあとの、次の聞き直し（待っている呼び出しで分け合う） */
  private queued: Promise<ClaudeAuthState | undefined> | null = null

  /** 実行ファイルは既定でサーバの PATH の `claude`（#288）。テストは偽物を渡す */
  constructor(bin: string = 'claude', ttl = AUTH_CACHE_MS, timeout = AUTH_TIMEOUT_MS, now: () => number = Date.now) {
    this.bin = bin
    this.ttl = ttl
    this.timeout = timeout
    this.now = now
  }

  peek(): ClaudeAuthState | undefined {
    return this.state
  }

  /**
   * 前の結果を使わずに聞き直す（#577。ログインの子が終わった直後・始める前は、数秒前の「切れている」を使わない）。
   * 走っている聞き直しの結果は使わず、そのあとにもう 1 回聞く（その 1 回は待っている呼び出しで分け合う）。**聞けなかったら前の結果を残す**（`check()` は「分からない」に戻すが、
   * ここで戻すと、ログインを始めようと押しただけでバナーごと消える）
   */
  refresh(): Promise<ClaudeAuthState | undefined> {
    // 走っている聞き直しは、**それが始まったあとの変化**（ログインの子がいま資格情報を書いた）を見ていないかもしれない。
    // その結果は返さず、終わってからもう 1 回聞く（待っている呼び出しは、その 1 回を分け合う）
    if (this.fresh) {
      this.queued ??= this.fresh.then(() => {
        this.queued = null
        return this.refresh()
      })
      return this.queued
    }
    const ask = async () => {
      if (this.asking) await this.asking
      // 走っていた分が書いた結果を「前の結果」にする（それより古いものへ戻さない）
      const kept = this.state
      this.at = 0
      const state = await this.check()
      if (state === undefined && kept) this.state = kept
      return state
    }
    this.fresh = ask().finally(() => {
      this.fresh = null
    })
    return this.fresh
  }

  check(): Promise<ClaudeAuthState | undefined> {
    if (this.asking) return this.asking
    if (this.at > 0 && this.now() - this.at < this.ttl) return Promise.resolve(this.state)
    this.asking = this.ask()
      .then((state) => {
        // 聞けなかったら「分からない」に戻す（前に「切れている」と聞いたままバナーを出し続けない）
        this.state = state
        this.at = this.now()
        return state
      })
      .finally(() => {
        this.asking = null
      })
    return this.asking
  }

  private ask(): Promise<ClaudeAuthState | undefined> {
    return new Promise((resolve) => {
      let out = ''
      let done = false
      const finish = (state: ClaudeAuthState | undefined) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(state)
      }
      let child
      try {
        // stdin は閉じる（聞かれて待たない）。stderr は捨てる
        child = spawn(this.bin, ['auth', 'status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        return resolve(undefined)
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(undefined)
      }, this.timeout)
      child.stdout.setEncoding('utf-8')
      child.stdout.on('data', (chunk: string) => {
        // 出力は数百バイト。壊れた版が垂れ流しても溜め込まない
        if (out.length < 65536) out += chunk
      })
      child.on('error', () => finish(undefined))
      child.on('close', () => finish(parseAuthStatus(out)))
    })
  }
}
