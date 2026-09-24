// このマシンで生きている Claude のセッションを `claude agents --json` から読む（#418）。
//
// 使うのは 1 つだけ: **そのセッションでいまターンが回っているか**（`status: "busy"`）。
// SAI はこれまで transcript の末尾から推測していて（#302 の `progressActive()`）、
// **端末で Esc を押して止めたターンは transcript では閉じないまま残る**ので、最大 10 分「処理中」が残っていた。
//
// `GhPr`（#211）と同じ作法で閉じてある:
//
// - 叩くのは `claude agents --json` の 1 形だけ。実行ファイルはサーバの PATH の `claude`（#288）
// - `claude` が無い・古くてこのサブコマンドが無い・時間切れ・JSON が壊れている、のどれでも
//   **`undefined`（分からない）を返すだけ**で、今までの判定をそのまま使う（材料が無いのに止めない）
// - `SAI_CLAUDE_AGENTS=0` で丸ごと切れる
// - **`--json` を必ず付ける**（付けないと `claude agents` は TTY を要求して断る）
import { spawn } from 'node:child_process'

/** 諦めるまで。画面のポーリングを待たせるので短く */
export const AGENTS_TIMEOUT_MS = 4000
/** 引き直さない時間。画面のポーリングは 3 秒なので、そのあいだは 1 回で足りる */
export const AGENTS_CACHE_MS = 3000

/** 生きている Claude のセッション 1 つ。`claude agents --json` の 1 要素（見るキーだけ） */
export interface ClaudeAgent {
  sessionId: string
  /** `interactive`（端末・`-p` の子）か `background`（`claude --bg`） */
  kind: string
  /** `busy` = いまターンが回っている。`idle` = 入力待ち */
  status: string
  cwd: string
  pid: number
  /** 自動で付く名前か、`-n` で渡した表示名（#391 / #413） */
  name: string
}

/** 生きているセッションを引く口。テストでは差し替える */
export interface AgentList {
  /** そのセッションでターンが回っているか。**分からなければ `undefined`**（false と区別する） */
  busy(sessionId: string): Promise<boolean | undefined>
}

/** 引かない実装（`SAI_CLAUDE_AGENTS=0`、テストの既定） */
export class NoAgents implements AgentList {
  busy(_sessionId: string): Promise<boolean | undefined> {
    return Promise.resolve(undefined)
  }
}

/**
 * `claude agents --json` の出力を読む。**読めなければ `null`**（空の配列と区別する。
 * 空は「生きているセッションが 1 つも無い」で、null は「聞けなかった」）
 */
export function parseAgents(stdout: string): ClaudeAgent[] | null {
  let obj: unknown
  try {
    obj = JSON.parse(stdout)
  } catch {
    return null
  }
  // いまは配列で返るが、`{ sessions: [...] }` の形になっても読めるようにしておく
  const list = Array.isArray(obj) ? obj : (obj as { sessions?: unknown } | null)?.sessions
  if (!Array.isArray(list)) return null
  const out: ClaudeAgent[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const sessionId = typeof o.sessionId === 'string' ? o.sessionId : ''
    if (!sessionId) continue
    out.push({
      sessionId,
      kind: typeof o.kind === 'string' ? o.kind : '',
      status: typeof o.status === 'string' ? o.status : '',
      cwd: typeof o.cwd === 'string' ? o.cwd : '',
      pid: typeof o.pid === 'number' ? o.pid : 0,
      name: typeof o.name === 'string' ? o.name : '',
    })
  }
  return out
}

/**
 * そのセッションでターンが回っているか。**同じ `sessionId` の行が複数あることがある**
 * （実測: 端末の TUI が `idle`、SAI が `-p --resume` で起こした子が同じ ID で `busy`）ので、
 * **1 つでも `busy` なら回っている**
 */
export function busyIn(agents: readonly ClaudeAgent[], sessionId: string): boolean {
  return agents.some((a) => a.sessionId === sessionId && a.status === 'busy')
}

export class ClaudeAgents implements AgentList {
  readonly bin: string
  private readonly ttl: number
  private readonly timeout: number
  private at = 0
  private agents: ClaudeAgent[] | null = null
  /**
   * 走っている 1 本（#433）。TTL が効くのは 1 本目が返ってからなので、それまでに来た呼び出しは
   * **これを待つ**（無いと、処理中のバブルが N 個あれば 3 秒ごとに `claude` が N プロセス起きる）。`CodexPanes.scanning` と同じ形
   */
  private listing: Promise<ClaudeAgent[] | null> | null = null

  /** 実行ファイルは既定でサーバの PATH の `claude`（#288）。テストは偽物を渡す */
  constructor(bin: string = 'claude', ttl = AGENTS_CACHE_MS, timeout = AGENTS_TIMEOUT_MS) {
    this.bin = bin
    this.ttl = ttl
    this.timeout = timeout
  }

  async busy(sessionId: string): Promise<boolean | undefined> {
    if (!sessionId) return undefined
    const agents = await this.list()
    return agents === null ? undefined : busyIn(agents, sessionId)
  }

  /** 生きているセッションの一覧。**セッションごとではなく全体で 1 回**叩いて、少しのあいだ覚える */
  private list(): Promise<ClaudeAgent[] | null> {
    if (this.agents !== null && Date.now() - this.at < this.ttl) return Promise.resolve(this.agents)
    this.listing ??= this.listNow().finally(() => {
      this.listing = null
    })
    return this.listing
  }

  private async listNow(): Promise<ClaudeAgent[] | null> {
    const parsed = parseAgents(await this.run())
    // 聞けなかったときは覚えない（次のポーリングでまた試す）
    if (parsed !== null) {
      this.agents = parsed
      this.at = Date.now()
    }
    return parsed
  }

  /** 失敗（claude が無い、古い、時間切れ）は空文字。例外は投げない */
  private run(): Promise<string> {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(this.bin, ['agents', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        return resolve('')
      }
      let out = ''
      let done = false
      const finish = (value: string) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish('')
      }, this.timeout)
      // 実測で 5KB ほど。増えても頭だけ見る
      child.stdout.on('data', (c: Buffer) => (out.length < 256 * 1024 ? (out += c.toString()) : undefined))
      child.once('error', () => finish(''))
      child.once('close', (code) => finish(code === 0 ? out : ''))
    })
  }
}

/** 環境変数から口を組む。`SAI_CLAUDE_AGENTS=0` なら聞きに行かない */
export function agentListFromEnv(env: NodeJS.ProcessEnv = process.env): AgentList {
  return env.SAI_CLAUDE_AGENTS === '0' ? new NoAgents() : new ClaudeAgents()
}
