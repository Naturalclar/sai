// tailnet から MCP（`/mcp`）で呼ぶときに、誰にどのツールを許すか（#312）。
// 許可の正本は tailnet の ACL（grants）。`tailscale whois` の `CapMap` に載った capability を読む
// （Serve の `Tailscale-App-Capabilities` ヘッダは使わない。identity と同じく、ヘッダはヒントでしかないので whois で引き直した値だけを見る）。
//
// grants の書き方（tailnet の ACL）:
//   "grants": [{
//     "src": ["autogroup:member"], "dst": ["<SAI のマシン>"],
//     "app": { "github.com/naturalclar/sai/cap/mcp": [{ "tools": ["read", "send"], "origins": ["https://dash.<tailnet>.ts.net"] }] }
//   }]
import type { CapMap, Identity } from '../auth.ts'

/** grants の `app` に書く capability の名前 */
export const MCP_CAP = 'github.com/naturalclar/sai/cap/mcp'

/** ツールのまとまり。`read` = 一覧・本文・手順を読む、`send` = 別のセッションに送る・返答を待つ */
export type McpScope = 'read' | 'send'
const SCOPES: readonly McpScope[] = ['read', 'send']

export interface McpAccess {
  scopes: ReadonlySet<McpScope>
  /** ブラウザから呼んでよいページの Origin（`https://host`。小文字、末尾の `/` なし）。CORS もこれにだけ返す */
  origins: ReadonlySet<string>
  /** 誰か。送った文の見出しに出し、送った回数と `sai_wait` の本人確認の鍵にする */
  caller: string
}

/** Origin の形にそろえる（小文字、末尾の `/` を落とす）。形が違えば空 */
export function normalizeOrigin(value: string): string {
  const v = value.trim().replace(/\/+$/, '').toLowerCase()
  return /^https?:\/\/[^/\s?#]+$/.test(v) ? v : ''
}

/** capability（`MCP_CAP` の値の配列）から、使ってよいツールのまとまりと Origin を集める。知らない値は捨てる */
export function parseMcpCaps(caps: CapMap): { scopes: Set<McpScope>; origins: Set<string> } {
  const scopes = new Set<McpScope>()
  const origins = new Set<string>()
  for (const entry of caps[MCP_CAP] ?? []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>
    if (Array.isArray(e.tools)) {
      for (const t of e.tools) if (SCOPES.includes(t as McpScope)) scopes.add(t as McpScope)
    }
    if (Array.isArray(e.origins)) {
      for (const o of e.origins) {
        const origin = typeof o === 'string' ? normalizeOrigin(o) : ''
        if (origin) origins.add(origin)
      }
    }
  }
  return { scopes, origins }
}

/**
 * - ループバックからの直アクセス: `read` だけ（このマシンのエージェントが送るのは #310 のエージェント用の口）
 * - tailnet のユーザー: `read` は capability が無くても使える（今の画面・REST と同じ範囲）。`send` は capability があるときだけ
 * - タグ付きの端末: capability に書いたものだけ（無ければ何も使えない）
 */
export function mcpAccess(who: Identity): McpAccess {
  if (who.kind === 'local') return { scopes: new Set(['read']), origins: new Set(), caller: 'このマシン' }
  const granted = parseMcpCaps(who.caps)
  if (who.kind === 'tailnet') granted.scopes.add('read')
  return { scopes: granted.scopes, origins: granted.origins, caller: who.kind === 'tailnet' ? who.login : `タグ付きの端末 ${who.node || '(名前なし)'}` }
}
