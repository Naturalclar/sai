#!/usr/bin/env node
// `claude -p --permission-prompt-tool mcp__sai__approve` から呼ばれる stdio の MCP サーバ。
// 依存ゼロで JSON-RPC を最小限（initialize / tools/list / tools/call）だけ話す。
//
// tools/call が来たら SAI サーバ（SAI_URL）に預けて、画面で答えが付くまで待ち、その決定を CLI に返す。
// 決定に updatedPermissions（「常に許可」のルール）が付いていればそのまま返す。CLI がそれを自分の設定に書く。
// CLI（2.1.259）はこのツールに permission_suggestions を送ってこない（tool_name / input / tool_use_id だけ）。
// stdout は MCP の配線そのものなので、ログは stderr（CLI が reply.log に流す）にしか書かない。
//
// 環境変数（runner.ts が --mcp-config の env で渡す）:
//   SAI_URL     SAI サーバ（http://127.0.0.1:8787）
//   SAI_ENTITY  返信先のエンティティID（<セッション>@<リポジトリ>）
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApprovalAnswer, ApprovalRequest } from '../shared/types.ts'

export const TOOL_NAME = 'approve'

const url = process.env.SAI_URL ?? ''
const entity = process.env.SAI_ENTITY ?? ''

const log = (msg: string) => process.stderr.write(`[sai-approve] ${msg}\n`)

interface Rpc {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

function send(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const deny = (message: string): ApprovalAnswer => ({ behavior: 'deny', message })

/** SAI に預けて、答えが付くまで待つ。SAI に届かなければ deny（許可を勝手に通さない） */
export async function decide(req: ApprovalRequest, base: string = url): Promise<ApprovalAnswer> {
  if (!base) return deny('SAI_URL が無い')
  let approvalId = ''
  try {
    const res = await fetch(`${base}/api/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) })
    if (!res.ok) return deny(`SAI が受け付けなかった: ${res.status} ${await res.text()}`)
    approvalId = ((await res.json()) as { approval_id: string }).approval_id
  } catch (err) {
    return deny(`SAI に届かない: ${err instanceof Error ? err.message : String(err)}`)
  }
  for (;;) {
    let res: Response
    try {
      res = await fetch(`${base}/api/approvals/${encodeURIComponent(approvalId)}?wait=1`)
    } catch (err) {
      return deny(`SAI に届かない: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (res.status === 200) return (await res.json()) as ApprovalAnswer
    if (res.status === 202) continue
    return deny(`SAI が答えを失った: ${res.status}`)
  }
}

async function handle(msg: Rpc): Promise<void> {
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: msg.id, result })
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params?.protocolVersion as string | undefined) ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'sai', version: '1' },
      })
    case 'tools/list':
      return reply({
        tools: [
          {
            name: TOOL_NAME,
            description: 'SAI の画面で許可・質問に答える',
            inputSchema: {
              type: 'object',
              properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
              required: ['tool_name', 'input'],
            },
          },
        ],
      })
    case 'tools/call': {
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      const toolName = typeof args.tool_name === 'string' ? args.tool_name : ''
      const input = args.input && typeof args.input === 'object' && !Array.isArray(args.input) ? (args.input as Record<string, unknown>) : {}
      const toolUseId = typeof args.tool_use_id === 'string' ? args.tool_use_id : ''
      const answer = toolName ? await decide({ id: entity, tool_name: toolName, input, tool_use_id: toolUseId }) : deny('tool_name が無い')
      log(`${toolName}: ${answer.behavior}`)
      return reply({ content: [{ type: 'text', text: JSON.stringify(answer) }] })
    }
    default:
      // 通知（notifications/initialized など）には返さない。知らない要求には空で返す
      if (msg.id !== undefined) reply({})
  }
}

export function serve(): void {
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg: Rpc
      try {
        msg = JSON.parse(line) as Rpc
      } catch {
        log(`壊れた行: ${line.slice(0, 80)}`)
        continue
      }
      void handle(msg).catch((err) => log(`失敗: ${err instanceof Error ? err.message : String(err)}`))
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve()
