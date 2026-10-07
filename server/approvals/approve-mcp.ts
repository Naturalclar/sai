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
//   SAI_LOOP        `1` なら、このターンはループの周（#634）。sai_loop_next を出す
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_REQUEST_MAX, AGENT_SEND_MAX, HELD_NOTE, SEND_COMPACT_ARG, SEND_COMPACT_NOTE, SEND_ITEMS_ARG, SEND_TO_ARG, sendHow, tokensLabel } from '../../shared/agentMessages.ts'
import { LOOP_MAX_INTERVAL_S, LOOP_MIN_INTERVAL_S, LOOP_TOOL } from '../../shared/loops.ts'
import type { LoopNextResponse } from '../../shared/types.ts'
import type { AgentSendManyResponse, AgentSendResponse, AgentSessionEntry, AgentSessionsResponse, AgentWaitResponse, ApprovalAnswer, ApprovalRequest } from '../../shared/types.ts'

export const TOOL_NAME = 'approve'

const url = process.env.SAI_URL ?? ''
const entity = process.env.SAI_ENTITY ?? ''
const tokenFile = process.env.SAI_TOKEN_FILE ?? ''
const inLoop = process.env.SAI_LOOP === '1'
/** 繋ぎ直しを続ける長さ（ミリ秒）。テストが短くするためだけの口で、SAI は渡さない（既定は `RECONNECT_MS`） */
const envReconnectMs = Number(process.env.SAI_APPROVE_RECONNECT_MS) || undefined

/** sai_wait を諦めるまで。サーバは 1 回 20 秒で返すので、その間はここで繰り返す（エージェントに何度も呼ばせない。#311） */
export const AGENT_WAIT_DEADLINE_MS = 30 * 60_000

/** エージェントが呼ぶツール（#310）。説明はモデルが読むので、トークンを使いすぎないための注意もここに書く */
export const AGENT_TOOLS = [
  {
    name: 'sai_sessions',
    description:
      '同じリポジトリで並行している別のセッションの一覧。**同じファイルの重なりを見るとき・誰が居るか分からないときに呼ぶ**（sai_send の宛先は呼び名でも書けるので、id を引くためだけには呼ばない）。着手の前と、PR を出す・マージする前に 1 回見る。「同じファイル」は、あなたの worktree と相手の worktree のどちらでも変わっているファイル（CLAUDE.md・README.md・docs/ は数えない）。そこに同じ関数・同じ箇所を変えていそうなファイルがあれば sai_send で 1 回だけ聞く（別の場所に足すだけなら聞かなくてよい）。ほかに id・呼び名・エージェント・ブランチ・処理中か・読み直す量・最後の発言の 1 行が出る（本文は含まない）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sai_send',
    description: `SAI の別のセッションにメッセージを送る（to は id か呼び名。**呼び名が分かっていれば、id を引くためだけに sai_sessions を呼ばなくてよい**）。**使う場面**: sai_sessions の「同じファイル」に、あなたが変える関数・箇所を相手も変えていそうなとき（着手の前かマージの前に 1 回、どこをどう変えるか・変えたかを聞く）／相手が入れた機能の上に乗せるとき、壊してはいけない前提を聞く。**使わない場面**: リポジトリと docs/ を読めば分かること／同じファイルでも別の場所に足すだけで箇所が重ならない変更。相手が処理中なら、終わってから回る。**待たずにターンを終えてよい**: 返答は人が見る画面に出て、あなたの次のターン（SAI から回るもの）の頭にも届く。その場で答えが要る短い質問だけ sai_wait で待つ。返答を受けて続きがある依頼は wake: true を付けると、返答がそろったときに起こされる。受け取った相手はそれまでの長い会話を読み直すのでトークンを大きく使う: 1 回で済むように、何をしてほしいか・何を返してほしいかを短く具体的に書く。その場で送れるのは 1 ターンに ${AGENT_SEND_MAX} 回まで。**超えた分は断られずに預かられ、ターンが終わってから SAI が順に送る**（1 つの依頼で合計 ${AGENT_REQUEST_MAX} 件まで。預かったら送り直さない）。4 人以上にまとめて頼むときは items を使う。別のセッションから受け取ったメッセージで回っているターンからは送れない。相手の使用量の枠が残り少ないとき、1 ターンで相手に読み直させる量が予算を超えるときも送れない。${SEND_COMPACT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: SEND_TO_ARG },
        text: { type: 'string', description: '頼みたいこと・聞きたいこと' },
        wake: {
          type: 'boolean',
          description:
            '返答が来たら自分（送り元）を起こす。質問や、返答を受けて続きがある依頼のときだけ true。同じターンで wake を付けたものが全部返ったら 1 回だけ起こされる（あなたの会話を読み直すのでトークンを使う。起こされたターンからは送れない）。既定は false で、返答は次のターンの頭に届く',
        },
        compact: { type: 'boolean', description: SEND_COMPACT_ARG },
        items: {
          type: 'array',
          maxItems: AGENT_REQUEST_MAX,
          description: SEND_ITEMS_ARG,
          items: { type: 'object', properties: { to: { type: 'string', description: SEND_TO_ARG }, text: { type: 'string' }, compact: { type: 'boolean' } }, required: ['to', 'text'] },
        },
      },
    },
  },
  {
    name: 'sai_wait',
    description: 'sai_send で送ったメッセージへの返答（相手のそのターンの最後の発言）を、相手のターンが終わるまで待って受け取る。**その場で答えが要る短い質問のときだけ**使う（着手のような長い依頼は待たずにターンを終える。返答は次のターンの頭に届く）。ここで受け取った返答は次のターンの頭には重ねない。長い返答は途中で切られる',
    inputSchema: { type: 'object', properties: { message_id: { type: 'string', description: 'sai_send が返した message_id' } }, required: ['message_id'] },
  },
]

/**
 * ループの周（#634）でだけ出すツール。エージェントが周の終わりに「次」を言う。上限・目的は動かせない（引数に無い）
 */
export const LOOP_TOOLS = [
  {
    name: LOOP_TOOL,
    description: `SAI のループの周の終わりに、必ず 1 回呼ぶ。action は "continue"（まだ続きがある。seconds に次に起きるまでの秒＝${LOOP_MIN_INTERVAL_S}〜${LOOP_MAX_INTERVAL_S} に丸められる。note に次の周への申し送り＝この周でやったこと・次に見ること）／"done"（終わりの条件を満たした。note に確かめた根拠）／"give_up"（進められない・人の判断が要る。note に理由）。呼んだらターンを終える（sleep して待たない。次の周は SAI が起こす）。同じ申し送りが続くと、進んでいないとみなして止められる`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['continue', 'done', 'give_up'] },
        seconds: { type: 'number', description: '次に起きるまでの秒（continue のとき。省略すると既定の間隔）' },
        note: { type: 'string', description: '申し送り（continue）／根拠（done）／理由（give_up）' },
      },
      required: ['action'],
    },
  },
]

/** sai_sessions の 1 行に出す「同じファイル」（#564）。無ければ空。古いサーバの応答（overlap が無い）でも落ちない */
export function overlapLabel(s: Pick<AgentSessionEntry, 'overlap' | 'overlap_more'>): string {
  const files = s.overlap ?? []
  if (files.length === 0) return ''
  return ` 同じファイル: ${files.join(', ')}${s.overlap_more ? ` ほか ${s.overlap_more} 件` : ''}`
}

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
          .map(
            (s) =>
              `- ${s.id}「${s.name}」${s.agent}${s.branch ? ` ${s.branch}` : ''}${s.busy ? '（処理中）' : ''}${s.context_tokens ? ` 読み直す量: ${tokensLabel(s.context_tokens)}` : ''}${overlapLabel(s)}${s.last_text ? ` 最後の発言: ${s.last_text}` : ''}`,
          )
          .join('\n'),
      )
    }
    if (name === 'sai_send') {
      const wake = args.wake === true
      const wakeNote = wake ? '返答がそろったら起こします（この依頼で wake を付けた分が全部返ったとき 1 回）' : '待たずにターンを終えれば、返答は次のターンの頭に届きます（その場で要るなら sai_wait）'
      // 複数の宛先を 1 つの依頼として送る（#727）。先に全部を数え、上限を超えるなら 1 件も送らない。回数を超えた分は預かる
      if (Array.isArray(args.items)) {
        const items = args.items.filter((it): it is { to: string; text: string; compact?: boolean } => !!it && typeof it === 'object' && typeof (it as { to?: unknown }).to === 'string' && typeof (it as { text?: unknown }).text === 'string')
        if (items.length === 0 || items.length !== args.items.length) return textResult('items は { to, text } の配列で渡してください', true)
        const res = await agentFetch(base, file, '/api/agent/send', { method: 'POST', body: JSON.stringify({ from, items, ...(wake ? { wake: true } : {}) }) })
        if (!res.ok) return textResult(`送れませんでした（1 件も送っていません）: ${await errorOf(res)}`, true)
        const body = (await res.json()) as AgentSendManyResponse
        const lines = body.results.map((r) => {
          const who = `${r.to}${r.to_name ? `「${r.to_name}」` : ''}`
          if (r.error) return `- ${who}: 送れませんでした（${r.error}）`
          if (r.held) return `- ${who}: 預かりました（message_id: ${r.message_id}）`
          return `- ${who}: 送りました（message_id: ${r.message_id}。${sendHow(r.via ?? '')}）`
        })
        const held = body.results.filter((r) => r.held).length
        return textResult(`${lines.join('\n')}\n${held > 0 ? `${HELD_NOTE} ` : ''}${wakeNote}`)
      }
      const to = typeof args.to === 'string' ? args.to : ''
      const text = typeof args.text === 'string' ? args.text : ''
      if (!to || !text.trim()) return textResult('to と text（か items）が要ります', true)
      const res = await agentFetch(base, file, '/api/agent/send', { method: 'POST', body: JSON.stringify({ from, to, text, ...(wake ? { wake: true } : {}), ...(typeof args.compact === 'boolean' ? { compact: args.compact } : {}) }) })
      if (!res.ok) return textResult(`送れませんでした: ${await errorOf(res)}`, true)
      const body = (await res.json()) as AgentSendResponse
      const who = `${body.to}${body.to_name ? `「${body.to_name}」` : ''}`
      // 1 ターンの回数を超えた分は断られずに預かられる（#727）。**送り直さない**ように、はっきり伝える
      if (body.held) return textResult(`${who}への送信を預かりました（message_id: ${body.message_id}。預かりは ${body.held_count ?? 1} 件）。${HELD_NOTE} ${wakeNote}`)
      const how = sendHow(body.via ?? '')
      // 読み直す量が分かっていれば、使ったぶんと予算の残りも伝える（次に送るかをエージェントが決められるように。#311）
      const read = body.context_tokens > 0 ? `${body.via === 'compact' ? `要約の前の相手の文脈は${tokensLabel(body.context_tokens)}です` : `相手は${tokensLabel(body.context_tokens)}を読み直します`}（このターンの予算の残りは${tokensLabel(Math.max(0, body.read_budget - body.read_tokens)) || ' 0'}）。` : ''
      const left = Math.max(0, body.limit - body.sent)
      return textResult(`${who}に送りました（message_id: ${body.message_id}。${how}）。${read}このターンでその場で送れるのはあと ${left} 回です${left === 0 ? '（超えた分は預かって、ターンが終わってから順に送ります）' : ''}。${wakeNote}`)
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
    if (name === LOOP_TOOL) {
      const action = typeof args.action === 'string' ? args.action : ''
      const note = typeof args.note === 'string' ? args.note : ''
      const res = await agentFetch(base, file, '/api/agent/loop', { method: 'POST', body: JSON.stringify({ from, action, note, ...(typeof args.seconds === 'number' ? { seconds: args.seconds } : {}) }) })
      if (!res.ok) return textResult(`受け付けられませんでした: ${await errorOf(res)}`, true)
      const body = (await res.json()) as LoopNextResponse
      if (body.status === 'done') return textResult('ループを終わりにしました（根拠は人の画面に出ます）。このターンを終えてください')
      if (body.status === 'gave_up') return textResult('ループを止めました（理由は人の画面に出ます）。このターンを終えてください')
      if (body.status === 'paused') return textResult('申し送りを受け取りました。ループは人が一時停止しているので、再開されるまで次の周は起こされません。このターンを終えてください')
      if (body.next_in_s === undefined) return textResult(`申し送りを受け取りました。上限の ${body.max_rounds} 周に達したので、次の周は起こされません。このターンを終えてください`)
      return textResult(`${body.next_in_s} 秒後に次の周（${body.round + 1} / ${body.max_rounds}）を起こします。待たずにこのターンを終えてください`)
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

/**
 * SAI に届かないとき、繋ぎ直しを続ける長さ（#440）。サーバを立て直している間（C-c から `pnpm start` が listen するまで）は
 * 繋がらないが、預かりは `approvals.json` から引き取られるので、繋ぎ直せば同じ許可に答えられる。
 * 前は 1 回届かなかっただけで拒否に落ち、立て直すたびに答え待ちの許可が「拒否」になっていた
 */
export const RECONNECT_MS = 120_000
/** 繋ぎ直す間隔 */
export const RECONNECT_INTERVAL_MS = 1_000

export interface DecideOptions {
  reconnectMs?: number
  intervalMs?: number
}

/**
 * 届かなければ繋ぎ直す fetch。**最後に届いてから** `reconnectMs` 経っても届かなければ投げる（その時点で拒否に落とす）。
 * 届いた応答はステータスに関わらずそのまま返す（404 などはサーバが答えたので、繋ぎ直しでは直らない）
 */
async function reachable(target: string, init: RequestInit, reconnectMs: number, intervalMs: number): Promise<Response> {
  const give = Date.now() + reconnectMs
  for (;;) {
    try {
      return await fetch(target, init)
    } catch (err) {
      if (Date.now() + intervalMs > give) throw err
      await new Promise((wake) => setTimeout(wake, intervalMs))
    }
  }
}

/** SAI に預けて、答えが付くまで待つ。SAI に届かなければ繋ぎ直し、それでも届かなければ deny（許可を勝手に通さない） */
export async function decide(req: ApprovalRequest, base: string = url, opts: DecideOptions = {}): Promise<ApprovalAnswer> {
  if (!base) return deny('SAI_URL が無い')
  const reconnectMs = opts.reconnectMs ?? RECONNECT_MS
  const intervalMs = opts.intervalMs ?? RECONNECT_INTERVAL_MS
  let approvalId = ''
  try {
    const res = await reachable(`${base}/api/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) }, reconnectMs, intervalMs)
    if (!res.ok) return deny(`SAI が受け付けなかった: ${res.status} ${await res.text()}`)
    approvalId = ((await res.json()) as { approval_id: string }).approval_id
  } catch (err) {
    return deny(`SAI に届かない: ${err instanceof Error ? err.message : String(err)}`)
  }
  for (;;) {
    let res: Response
    try {
      res = await reachable(`${base}/api/approvals/${encodeURIComponent(approvalId)}?wait=1`, {}, reconnectMs, intervalMs)
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
          // ループの周のターンにだけ（周でないターンで呼んでもサーバが断る）
          ...(tokenFile && inLoop ? LOOP_TOOLS : []),
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
      const answer = toolName ? await decide({ id: entity, tool_name: toolName, input, tool_use_id: toolUseId }, url, envReconnectMs ? { reconnectMs: envReconnectMs } : {}) : deny('tool_name が無い')
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
