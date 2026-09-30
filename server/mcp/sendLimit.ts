// tailnet の MCP から別のセッションに送る回数の上限（#312）。
// エージェント用の口（#311）は「送り元の 1 ターンに 3 回」で縛るが、tailnet から呼ぶ側は SAI が起動したターンではなく
// ターンの区切りが無いので、呼んだ人（ログイン名 / タグ付きの端末）ごとに一定時間の回数で縛る。
// **サーバを立て直しても数え直さない**（#440）: `statePath`（`~/.agent-feed/mcp-sends.json`）に送った時刻を書き、
// 起動時に読む（窓の外に出たものは読むときに捨てる）。前はメモリだけで、立て直すたびに 10 分 5 回の枠が空に戻った
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 1 人が MCP_SEND_WINDOW_MS の間に送れる回数 */
export const MCP_SEND_MAX = 5
export const MCP_SEND_WINDOW_MS = 10 * 60_000
/** 送った時刻を残すファイル（feed dir の中。#440） */
export const MCP_SENDS_FILE = 'mcp-sends.json'

export class McpSendLimiter {
  private readonly sent = new Map<string, number[]>()
  private readonly now: () => number
  private readonly statePath: string

  /** `statePath` を渡せば、前のサーバが残した送った時刻を読み、以後の送信を書く。渡さなければメモリだけ（テスト） */
  constructor(now: () => number = Date.now, statePath = '') {
    this.now = now
    this.statePath = statePath
    this.load()
  }

  private load(): void {
    if (!this.statePath) return
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.statePath, 'utf-8'))
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const since = this.now() - MCP_SEND_WINDOW_MS
    for (const [caller, times] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(times)) continue
      const kept = times.filter((t): t is number => typeof t === 'number' && t > since)
      if (kept.length > 0) this.sent.set(caller, kept)
    }
  }

  /** tmp → rename（`replying.json` と同じ）。窓の外のものは書かない。書けなくても送る口は止めない */
  private persist(): void {
    if (!this.statePath) return
    const since = this.now() - MCP_SEND_WINDOW_MS
    const body: Record<string, number[]> = {}
    for (const [caller, times] of this.sent) {
      const kept = times.filter((t) => t > since)
      if (kept.length > 0) body[caller] = kept
    }
    try {
      mkdirSync(dirname(this.statePath), { recursive: true })
      const tmp = `${this.statePath}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(body) + '\n', { mode: 0o600 })
      renameSync(tmp, this.statePath)
    } catch {
      // 書けなくてもメモリで数える（立て直すと数え直すだけ。#440 より前と同じ）
    }
  }

  private recent(caller: string): number[] {
    const since = this.now() - MCP_SEND_WINDOW_MS
    const kept = (this.sent.get(caller) ?? []).filter((t) => t > since)
    this.sent.set(caller, kept)
    return kept
  }

  /** 送れないなら理由。送れるなら空 */
  refusal(caller: string): string {
    return this.recent(caller).length >= MCP_SEND_MAX ? `送れるのは ${MCP_SEND_WINDOW_MS / 60_000} 分に ${MCP_SEND_MAX} 回までです。続けるなら人に確かめてください` : ''
  }

  record(caller: string): void {
    this.recent(caller).push(this.now())
    this.persist()
  }

  /**
   * いまの区切り（MCP_SEND_WINDOW_MS ごと）の鍵。相手に読み直させる量の予算（#311）を、エージェント用の口の「1 ターン」の代わりに
   * この区切りで数える（回数は直近 10 分の出入りで数えるが、予算の合計は区切りで持つ `AgentMessages` に乗せるため）
   */
  windowKey(): string {
    return `mcp-window-${Math.floor(this.now() / MCP_SEND_WINDOW_MS)}`
  }
}
