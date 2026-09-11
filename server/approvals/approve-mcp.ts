#!/usr/bin/env node
// `claude -p --permission-prompt-tool mcp__sai__approve` から呼ばれる stdio の MCP サーバ。
// 依存ゼロで JSON-RPC を最小限（initialize / tools/list / tools/call）だけ話す。
//
// tools/call が来たら SAI サーバ（SAI_URL）に預けて、画面で答えが付くまで待ち、その決定を CLI に返す。
// 決定に updatedPermissions（「常に許可」のルール）が付いていればそのまま返す。CLI がそれを自分の設定に書く。
// CLI（2.1.259）はこのツールに permission_suggestions を送ってこない（tool_name / input / tool_use_id だけ）。
// stdout は MCP の配線そのものなので、ログは stderr（CLI が reply.log に流す）にしか書かない。
//
// もう 1 つの役目は、エージェントが SAI の別のセッションに話しかけるツール（#310）。
// sai_sessions / sai_send / sai_wait を足し、SAI サーバのエージェント用の口（/api/agent/*）を叩く。
// その口はトークン（SAI_TOKEN_FILE のファイル）を要るので、トークンの置き場を渡されたときだけ一覧に出す。
//
// 環境変数（runner.ts が --mcp-config の env で渡す）:
//   SAI_URL         SAI サーバ（http://127.0.0.1:8787）
//   SAI_ENTITY      返信先のエンティティID（<セッション>@<リポジトリ>）。sai_* では送り元になる
//   SAI_TOKEN_FILE  エージェント用の口のトークンを置いたファイル。中身は env にも引数にも載せない（ps で見える）
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_SEND_MAX } from '../../shared/agentMessages.ts'
import type { AgentSendResponse, AgentSessionsResponse, AgentWaitResponse, ApprovalAnswer, ApprovalRequest } from '../../shared/types.ts'

export const TOOL_NAME = 'approve'

const url = process.env.SAI_URL ?? ''
const entity = process.env.SAI_ENTITY ?? ''
const tokenFile = process.env.SAI_TOKEN_FILE ?? ''

/** sai_wait を諦めるまで。サーバは 1 回 20 秒で返すので、その間はここで繰り返す（エージェントに何度も呼ばせない。#311） */
export const AGENT_WAIT_DEADLINE_MS = 30 * 60_000

/** エージェントが呼ぶツール（#310）。説明はモデルが読むので、トークンを使いすぎないための注意もここに書く */
export const AGENT_TOOLS = [
  {
    name: 'sai_sessions',
    description:
      'SAI に並んでいる、同じリポジトリの別のセッション（話しかけられる相手）の一覧。id・呼び名・エージェント・ブランチ・処理中か・最後の発言の 1 行だけで、本文は含まない。別のセッションに頼む・聞く前に使う',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sai_send',
    description: `SAI の別のセッションにメッセージを送る（to は sai_sessions の id）。相手が処理中なら、終わってから回る。返答は sai_wait で受け取る。1 ターンに ${AGENT_SEND_MAX} 回まで、別のセッションから受け取ったメッセージで回っているターンからは送れない。受け取った相手はそれまでの長い会話を読み直すのでトークンを大きく使う: 1 回で済むように、何をしてほしいか・何を返してほしいかを短く具体的に書く`,
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string', description: '送り先のセッションの id' }, text: { type: 'string', description: '頼みたいこと・聞きたいこと' } },
      required: ['to', 'text'],
    },
  },
  {
    name: 'sai_wait',
    description: 'sai_send で送ったメッセージへの返答（相手のそのターンの最後の発言）を、相手のターンが終わるまで待って受け取る。長い返答は途中で切られる',
    inputSchema: { type: 'object', properties: { message_id: { type: 'string', description: 'sai_send が返した message_id' } }, required: ['message_id'] },
  },
]

export interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

const textResult = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })

/** エージェント用の口を叩く。トークンは毎回ファイルから読む（サーバが作り直していても追いつく） */
async function agentFetch(base: string, file: string, path: string, init: RequestInit = {}): Promise<Response> {
  let token = ''
  try {
    token = readFileSync(file, 'utf-8').trim()
  } catch {
    // 読めなければ空で送り、サーバに断られる
  }
  return fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'X-SAI-Agent-Token': token } })
}

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    return typeof body.error === 'string' ? body.error : `${res.status}`
  } catch {
    return `${res.status}`
  }
}

/**
 * sai_sessions / sai_send / sai_wait の中身（#310）。失敗はツールのエラー（isError）として返し、エージェントに理由を読ませる。
 * 引数の既定値は環境変数で、テストは差し替える
 */
export async function agentTool(
  name: string,
  args: Record<string, unknown>,
  base: string = url,
  from: string = entity,
  file: string = tokenFile,
  deadlineMs: number = AGENT_WAIT_DEADLINE_MS,
): Promise<ToolResult> {
  if (!base || !from) return textResult('SAI から起動したターンではないので使えません（SAI_URL / SAI_ENTITY が無い）', true)
  if (!file) return textResult('SAI のトークンの置き場が渡されていません（SAI_TOKEN_FILE が無い）', true)
  try {
    if (name === 'sai_sessions') {
      const res = await agentFetch(base, file, `/api/agent/sessions?from=${encodeURIComponent(from)}`)
      if (!res.ok) return textResult(`一覧を取れませんでした: ${await errorOf(res)}`, true)
      const body = (await res.json()) as AgentSessionsResponse
      if (body.sessions.length === 0) return textResult('話しかけられるセッションはありません（同じリポジトリの、SAI から返信できるセッションだけが相手になります）')
      return textResult(
        body.sessions
          .map((s) => `- ${s.id}「${s.name}」${s.agent}${s.branch ? ` ${s.branch}` : ''}${s.busy ? '（処理中）' : ''}${s.last_text ? ` 最後の発言: ${s.last_text}` : ''}`)
          .join('\n'),
      )
    }
    if (name === 'sai_send') {
      const to = typeof args.to === 'string' ? args.to : ''
      const text = typeof args.text === 'string' ? args.text : ''
      if (!to || !text.trim()) return textResult('to と text が要ります', true)
      const res = await agentFetch(base, file, '/api/agent/send', { method: 'POST', body: JSON.stringify({ from, to, text }) })
      if (!res.ok) return textResult(`送れませんでした: ${await errorOf(res)}`, true)
      const body = (await res.json()) as AgentSendResponse
      const how = body.via === 'queued' ? '相手は処理中なので、終わってから回ります' : '相手のターンを始めました'
      return textResult(`送りました（message_id: ${body.message_id}。${how}）。このターンで送れるのはあと ${Math.max(0, body.limit - body.sent)} 回です。返答は sai_wait で受け取れます`)
    }
    if (name === 'sai_wait') {
      const id = typeof args.message_id === 'string' ? args.message_id : ''
      if (!id) return textResult('message_id が要ります', true)
      const deadline = Date.now() + deadlineMs
      for (;;) {
        const res = await agentFetch(base, file, `/api/agent/wait?from=${encodeURIComponent(from)}&message_id=${encodeURIComponent(id)}&wait=1`)
        if (res.status === 202) {
          if (Date.now() >= deadline) return textResult(`まだ返答がありません（${Math.round(deadlineMs / 60_000)} 分待った）。あとでもう一度 sai_wait を呼べます`)
          continue
        }
        if (!res.ok) return textResult(`返答を受け取れませんでした: ${await errorOf(res)}`, true)
        const body = (await res.json()) as AgentWaitResponse
        if (body.status === 'failed') return textResult(`相手のターンが失敗しました: ${body.error ?? ''}`, true)
        return textResult(body.text ?? '')
      }
    }
    return textResult(`知らないツール: ${name}`, true)
  } catch (err) {
    return textResult(`SAI に届かない: ${err instanceof Error ? err.message : String(err)}`, true)
  }
}

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
          // トークンの置き場が無ければ出さない（叩いても断られるツールをモデルに見せない）
          ...(tokenFile ? AGENT_TOOLS : []),
        ],
      })
    case 'tools/call': {
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      // 名前の無い呼び出しは今までどおり approve（--permission-prompt-tool から来る）
      const called = typeof msg.params?.name === 'string' ? msg.params.name : TOOL_NAME
      if (called !== TOOL_NAME) {
        const result = await agentTool(called, args)
        log(`${called}: ${result.isError ? 'error' : 'ok'}`)
        return reply(result)
      }
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
