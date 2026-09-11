// tailnet の MCP から別のセッションに送る回数の上限（#312）。
// エージェント用の口（#311）は「送り元の 1 ターンに 3 回」で縛るが、tailnet から呼ぶ側は SAI が起動したターンではなく
// ターンの区切りが無いので、呼んだ人（ログイン名 / タグ付きの端末）ごとに一定時間の回数で縛る。メモリだけ
/** 1 人が MCP_SEND_WINDOW_MS の間に送れる回数 */
export const MCP_SEND_MAX = 5
export const MCP_SEND_WINDOW_MS = 10 * 60_000

export class McpSendLimiter {
  private readonly sent = new Map<string, number[]>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
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
  }

  /**
   * いまの区切り（MCP_SEND_WINDOW_MS ごと）の鍵。相手に読み直させる量の予算（#311）を、エージェント用の口の「1 ターン」の代わりに
   * この区切りで数える（回数は直近 10 分の出入りで数えるが、予算の合計は区切りで持つ `AgentMessages` に乗せるため）
   */
  windowKey(): string {
    return `mcp-window-${Math.floor(this.now() / MCP_SEND_WINDOW_MS)}`
  }
}
