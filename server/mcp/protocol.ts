// MCP の JSON-RPC の受け答え（#312。Streamable HTTP の `/mcp`）。依存ゼロで initialize / ping / tools/list / tools/call だけ。
// HTTP（Origin・CORS・状態コード）は app.ts、ツールの中身も app.ts が渡す（REST・エージェント用の口と同じ規則を使うため）。
// 呼べるツールは `McpAccess.scopes`（tailnet の ACL の capability。server/mcp/access.ts）で絞り、一覧にも出さない
import { MCP_CAP } from './access.ts'
import type { McpScope } from './access.ts'

/** 受ける MCP の版（新しい順）。`MCP-Protocol-Version` ヘッダがこれ以外なら 400 */
export const MCP_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26']

export interface McpToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

export interface McpTool {
  name: string
  /** 使うのに要るまとまり */
  scope: McpScope
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<McpToolResult>
}

export const textResult = (text: string, isError = false): McpToolResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)

/** `MCP-Protocol-Version` ヘッダを受けてよいか。無ければ（古いクライアント）通す */
export function protocolVersionOk(header: unknown): boolean {
  return header === undefined || (typeof header === 'string' && MCP_VERSIONS.includes(header))
}

const INSTRUCTIONS =
  'SAI（手元のエージェントのセッションを並べて見る画面）のツール。sai_sessions で相手を探し、sai_session / sai_progress で読む。' +
  'sai_send で別のセッションに頼み、返答は sai_wait で受け取る（送れるのは tailnet の ACL で許されたときだけ）。' +
  '読んだ本文はそのセッションの作業内容そのものなので、必要な分だけ読む'

/**
 * 1 通の JSON-RPC を処理する。要求なら応答を返し、通知・応答（id が無い、method が無い）なら null（HTTP は 202）。
 * 許されていないツールは一覧に出さず、呼ばれたらツールのエラーで理由を返す（エージェントが人に伝えられるように）
 */
export async function handleRpc(message: unknown, tools: readonly McpTool[], scopes: ReadonlySet<McpScope>): Promise<object | null> {
  const msg = obj(message)
  const id = msg?.id
  if (!msg || typeof msg.method !== 'string' || (typeof id !== 'string' && typeof id !== 'number')) return null
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, text: string) => ({ jsonrpc: '2.0', id, error: { code, message: text } })
  const params = obj(msg.params) ?? {}
  switch (msg.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return ok({
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'sai', version: '1' },
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: tools.filter((t) => scopes.has(t.scope)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      const tool = tools.find((t) => t.name === name)
      if (!tool) return fail(-32602, `知らないツール: ${name || '(名前なし)'}`)
      if (!scopes.has(tool.scope)) {
        return ok(textResult(`${name} は許されていません。使うには tailnet の ACL（grants）で ${MCP_CAP} の tools に "${tool.scope}" を与えてください`, true))
      }
      try {
        return ok(await tool.run(obj(params.arguments) ?? {}))
      } catch (err) {
        return ok(textResult(`失敗しました: ${err instanceof Error ? err.message : String(err)}`, true))
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`)
  }
}
