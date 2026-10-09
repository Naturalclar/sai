// SAI の MCP サーバの、別のセッションに話しかけるツール（#310）。偽の SAI サーバを立てて agentTool() を直接呼ぶのと、
// 子プロセスとして立てて tools/list に出るかを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APPROVE_MCP_PATH } from '../reply/runner.ts'
import { AGENT_TOOLS, agentTool, LOOP_TOOLS, overlapLabel } from './approve-mcp.ts'

let dir: string
let server: Server
let base: string
let tokenFile: string
const seen: { method: string; url: string; token: string; body: string }[] = []
/** /api/agent/loop が返すもの（#634） */
let loopReply: { status: number; body: unknown } = { status: 200, body: {} }
let waitForReply: { status: number; body: unknown } = { status: 200, body: {} }
/** /api/agent/send が次に返すもの（無ければいつもの 1 件ぶん）。1 回使ったら戻る */
let sendReply: { status: number; body: unknown } | null = null
/** /api/agent/sessions が次に返す一覧（無ければいつもの 1 件）。1 回使ったら戻る */
let sessionsReply: unknown[] | null = null
/** /api/agent/wait が順に返すもの */
let waits: { status: number; body: unknown }[] = []

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = ''
    req.on('data', (c: Buffer) => (s += c.toString()))
    req.on('end', () => resolve(s))
  })

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-agent-tools-'))
  tokenFile = join(dir, 'agent-token')
  await writeFile(tokenFile, 'secret-token\n')
  server = createServer((req, res) => {
    void readBody(req).then((body) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', token: String(req.headers['x-sai-agent-token'] ?? ''), body })
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (req.url?.startsWith('/api/agent/sessions')) {
        if (sessionsReply) {
          const list = sessionsReply
          sessionsReply = null
          return reply(200, { from: 'A1@r', sessions: list })
        }
        return reply(200, { from: 'A1@r', sessions: [{ id: 'B1@r', name: 'レビュー', project: 'o/r', branch: 'main', agent: 'claude', busy: true, last_text: '見ました', context_tokens: 120_000 }] })
      }
      if (req.url === '/api/agent/send') {
        if (sendReply) {
          const next = sendReply
          sendReply = null
          return reply(next.status, next.body)
        }
        return reply(202, { message_id: 'm1', to: 'B1@r', to_name: 'レビュー', via: 'queued', sent: 1, limit: 3, context_tokens: 900_000, read_tokens: 900_000, read_budget: 3_000_000 })
      }
      if (req.url === '/api/agent/wait-for') return reply(waitForReply.status, waitForReply.body)
      if (req.url?.startsWith('/api/agent/wait')) {
        const next = waits.shift() ?? { status: 404, body: { error: 'そのメッセージは見つかりません' } }
        return reply(next.status, next.body)
      }
      if (req.url === '/api/agent/loop') return reply(loopReply.status, loopReply.body)
      reply(404, { error: 'not found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

test('agentTool: トークンをファイルから読んでヘッダに載せ、sai_sessions を短い一覧にする', async () => {
  seen.length = 0
  const result = await agentTool('sai_sessions', {}, base, 'A1@r', tokenFile)
  assert.equal(result.isError, undefined)
  assert.equal(result.content[0]!.text, '- B1@r「レビュー」claude main（処理中） 読み直す量: 約 12 万トークン 最後の発言: 見ました')
  assert.equal(seen[0]!.token, 'secret-token', 'トークンは env ではなくファイルから読む')
  assert.equal(seen[0]!.url, '/api/agent/sessions?from=A1%40r')
})

test('agentTool: sai_sessions は別のリポジトリのセッションを分けて出す。出すのは呼び名・エージェント・空いているか、まで（#747）', async () => {
  const here = { id: 'B1@r', name: 'レビュー', project: 'o/r', branch: 'main', agent: 'claude', busy: false, last_text: '見ました', context_tokens: 0, overlap: [], overlap_more: 0 }
  const across = { id: 'C1@x', name: '実装', project: 'o/other', branch: '', agent: 'codex', busy: false, last_text: '', context_tokens: 0, overlap: [], overlap_more: 0, across: true, holding: { free: true } }
  sessionsReply = [here, across, { ...across, id: 'D1@x', name: '調査', busy: true, holding: undefined }]
  const text = (await agentTool('sai_sessions', {}, base, 'A1@r', tokenFile)).content[0]!.text
  assert.equal(
    text,
    ['- B1@r「レビュー」claude main 最後の発言: 見ました', '', '別のリポジトリ（送れる。相手からは、あなたのリポジトリのファイルは読めません）:', '- C1@x「実装」o/other codex （空き）', '- D1@x「調査」o/other codex（処理中）'].join('\n'),
  )
  // 別のリポジトリの相手だけのときは、見出しから始まる
  sessionsReply = [across]
  assert.ok((await agentTool('sai_sessions', {}, base, 'A1@r', tokenFile)).content[0]!.text.startsWith('別のリポジトリ（送れる。'))
  const send = AGENT_TOOLS.find((t) => t.name === 'sai_send')!.description
  assert.match(send, /宛先からは送り元のリポジトリのファイルが読めない前提で、本文だけで動けるように書く/)
})

test('agentTool: sai_send は送り元・送り先・本文を送り、預けたか・あと何回送れるかを返す', async () => {
  seen.length = 0
  const result = await agentTool('sai_send', { to: 'B1@r', text: '見て' }, base, 'A1@r', tokenFile)
  assert.match(result.content[0]!.text, /^B1@r「レビュー」に送りました（message_id: m1。相手は処理中なので、終わってから回ります/, 'どこに届いたか（id と呼び名。#625）')
  assert.match(result.content[0]!.text, /その場で送れるのはあと 2 回です。/)
  assert.match(result.content[0]!.text, /相手は約 90 万トークンを読み直します（このターンの予算の残りは約 210 万トークン）/, '次に送るかを決められるよう、読み直す量と予算の残りも伝える（#311）')
  assert.deepEqual(JSON.parse(seen[0]!.body), { from: 'A1@r', to: 'B1@r', text: '見て' })
  const missing = await agentTool('sai_send', { to: 'B1@r' }, base, 'A1@r', tokenFile)
  assert.equal(missing.isError, true)
  // 要約の指定（#624）は、真偽値のときだけ送る
  seen.length = 0
  await agentTool('sai_send', { to: 'B1@r', text: '見て', compact: false }, base, 'A1@r', tokenFile)
  await agentTool('sai_send', { to: 'B1@r', text: '見て', compact: 'yes' }, base, 'A1@r', tokenFile)
  assert.deepEqual(seen.map((s) => JSON.parse(s.body)), [{ from: 'A1@r', to: 'B1@r', text: '見て', compact: false }, { from: 'A1@r', to: 'B1@r', text: '見て' }])
})

test('agentTool: sai_wait は 202 の間サーバ側の待ちを繰り返し、返答の本文を返す。失敗と期限切れも言葉で返す（#311）', async () => {
  seen.length = 0
  waits = [
    { status: 202, body: { status: 'pending' } },
    { status: 202, body: { status: 'pending' } },
    { status: 200, body: { message_id: 'm1', to: 'B1@r', status: 'done', text: '見ました。問題なし' } },
  ]
  const done = await agentTool('sai_wait', { message_id: 'm1' }, base, 'A1@r', tokenFile)
  assert.equal(done.content[0]!.text, '見ました。問題なし')
  assert.equal(seen.length, 3, 'エージェントに呼び直させず、ここで繰り返す')
  assert.ok(seen.every((s) => s.url === '/api/agent/wait?from=A1%40r&message_id=m1&wait=1'))

  waits = [{ status: 200, body: { message_id: 'm1', to: 'B1@r', status: 'failed', error: '終了コード 3: boom' } }]
  const failed = await agentTool('sai_wait', { message_id: 'm1' }, base, 'A1@r', tokenFile)
  assert.equal(failed.isError, true)
  assert.match(failed.content[0]!.text, /相手のターンが失敗しました: 終了コード 3: boom/)

  waits = [{ status: 202, body: { status: 'pending' } }]
  const late = await agentTool('sai_wait', { message_id: 'm1' }, base, 'A1@r', tokenFile, 0)
  assert.match(late.content[0]!.text, /まだ返答がありません/)
})

test('agentTool: SAI から起動したターンでない・トークンの置き場が無い・SAI に届かないときは isError', async () => {
  assert.equal((await agentTool('sai_sessions', {}, base, '', tokenFile)).isError, true)
  assert.equal((await agentTool('sai_sessions', {}, base, 'A1@r', '')).isError, true)
  const unreachable = await agentTool('sai_sessions', {}, 'http://127.0.0.1:9', 'A1@r', tokenFile)
  assert.equal(unreachable.isError, true)
  assert.match(unreachable.content[0]!.text, /SAI に届かない/)
  assert.equal((await agentTool('sai_nope', {}, base, 'A1@r', tokenFile)).isError, true)
})

/** 子に JSON-RPC を 1 行送って、id が一致する応答を待つ */
function rpc(child: ChildProcess, msg: { id: number } & Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('応答が無い')), 10_000)
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        const obj = JSON.parse(line) as Record<string, unknown>
        if (obj.id === msg.id) {
          clearTimeout(timer)
          child.stdout!.off('data', onData)
          resolve(obj)
        }
      }
    }
    child.stdout!.on('data', onData)
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  })
}

test('approve-mcp.ts: トークンの置き場を渡されたときだけ sai_* を一覧に出し、tools/call で呼べる（approve は先頭のまま）', async () => {
  const names = async (env: Record<string, string>) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', APPROVE_MCP_PATH], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      const list = await rpc(child, { id: 1, method: 'tools/list' })
      const tools = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name)
      const call = env.SAI_TOKEN_FILE ? await rpc(child, { id: 2, method: 'tools/call', params: { name: 'sai_sessions', arguments: {} } }) : null
      return { tools, call }
    } finally {
      child.kill()
    }
  }
  const without = await names({ SAI_URL: base, SAI_ENTITY: 'A1@r' })
  assert.deepEqual(without.tools, ['approve'], 'トークンの置き場が無ければ、叩いても断られるツールを見せない')
  const withToken = await names({ SAI_URL: base, SAI_ENTITY: 'A1@r', SAI_TOKEN_FILE: tokenFile })
  assert.deepEqual(withToken.tools, ['approve', 'sai_sessions', 'sai_send', 'sai_wait', 'sai_wait_for'], 'ループの周でないターンには sai_loop_next を見せない（#634）')
  const inLoop = await names({ SAI_URL: base, SAI_ENTITY: 'A1@r', SAI_TOKEN_FILE: tokenFile, SAI_LOOP: '1' })
  assert.deepEqual(inLoop.tools, ['approve', 'sai_sessions', 'sai_send', 'sai_wait', 'sai_wait_for', 'sai_loop_next'])
  const text = ((withToken.call!.result as { content: { text: string }[] }).content[0]!.text)
  assert.match(text, /B1@r「レビュー」/)
})

test('overlapLabel: 同じファイルを 1 行に出す。無ければ空・古いサーバの応答（overlap が無い）でも落ちない（#564）', () => {
  assert.equal(overlapLabel({ overlap: ['server/app.ts', 'shared/types.ts'], overlap_more: 0 }), ' 同じファイル: server/app.ts, shared/types.ts')
  assert.equal(overlapLabel({ overlap: ['a.ts'], overlap_more: 3 }), ' 同じファイル: a.ts ほか 3 件')
  assert.equal(overlapLabel({ overlap: [], overlap_more: 0 }), '')
  assert.equal(overlapLabel({} as never), '', '上の sai_sessions の偽物は overlap を返さない（古いサーバ）')
})

test('agentTool: sai_send が預かられたら「送り直さない」と伝える。items は 1 つの依頼として送り、1 件ずつの結果を返す（#727）', async () => {
  seen.length = 0
  sendReply = { status: 202, body: { message_id: 'm9', to: 'B1@r', to_name: 'レビュー', held: true, held_count: 2, sent: 3, limit: 3, context_tokens: 0, read_tokens: 0, read_budget: 3_000_000 } }
  const held = await agentTool('sai_send', { to: 'B1@r', text: '4 件目' }, base, 'A1@r', tokenFile)
  assert.equal(held.isError, undefined, '預かりは失敗ではない')
  assert.match(held.content[0]!.text, /^B1@r「レビュー」への送信を預かりました（message_id: m9。預かりは 2 件）/)
  assert.match(held.content[0]!.text, /同じものを送り直さないでください/)
  assert.match(held.content[0]!.text, /「送信を止める」を押すと、残りは送られません/)

  sendReply = {
    status: 202,
    body: {
      results: [
        { message_id: 'a1', to: 'B1@r', to_name: 'レビュー', via: 'process', context_tokens: 0 },
        { message_id: 'a2', to: 'C1@r', to_name: '実装', held: true, context_tokens: 0 },
        { message_id: 'a3', to: 'D1@r', to_name: '調査', error: '起動できませんでした', context_tokens: 0 },
      ],
      sent: 3, limit: 3, held_count: 1, read_tokens: 0, read_budget: 3_000_000,
    },
  }
  const items = [{ to: 'B1@r', text: '一' }, { to: 'C1@r', text: '二' }, { to: 'D1@r', text: '三' }]
  const many = await agentTool('sai_send', { items, wake: true }, base, 'A1@r', tokenFile)
  assert.deepEqual(JSON.parse(seen[1]!.body), { from: 'A1@r', items, wake: true }, 'to / text は送らない')
  const lines = many.content[0]!.text.split('\n')
  assert.match(lines[0]!, /^- B1@r「レビュー」: 送りました（message_id: a1。相手のターンを始めました）/)
  assert.match(lines[1]!, /^- C1@r「実装」: 預かりました（message_id: a2）/)
  assert.match(lines[2]!, /^- D1@r「調査」: 送れませんでした（起動できませんでした）/)
  assert.match(lines[3]!, /同じものを送り直さないでください/)
  // 依頼ごと断られたら、1 件も送っていないと伝える
  sendReply = { status: 429, body: { error: 'この依頼で相手に読み直させる量の合計が予算を超えます' } }
  const refused = await agentTool('sai_send', { items }, base, 'A1@r', tokenFile)
  assert.equal(refused.isError, true)
  assert.match(refused.content[0]!.text, /^送れませんでした（1 件も送っていません）: /)
  // 形の違う items は送らない
  const before = seen.length
  assert.equal((await agentTool('sai_send', { items: [{ to: 'B1@r' }] }, base, 'A1@r', tokenFile)).isError, true)
  assert.equal((await agentTool('sai_send', { items: [] }, base, 'A1@r', tokenFile)).isError, true)
  assert.equal(seen.length, before)
  // 空の items は付いていないのと同じ（to / text の形として送る）
  await agentTool('sai_send', { to: 'B1@r', text: '見て', items: [] }, base, 'A1@r', tokenFile)
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { from: 'A1@r', to: 'B1@r', text: '見て' })
})

test('AGENT_TOOLS: 説明を書き直しても、ツールの名前と引数は変わらない（#564）', () => {
  assert.deepEqual(
    AGENT_TOOLS.map((t) => [t.name, Object.keys(t.inputSchema.properties), 'required' in t.inputSchema ? t.inputSchema.required : []]),
    [
      ['sai_sessions', [], []],
      // to / text は必須にしない（#727。items で渡す形がある。どちらも無ければツールが言葉で断る）
      ['sai_send', ['to', 'text', 'wake', 'compact', 'items'], []],
      ['sai_wait', ['message_id'], ['message_id']],
      ['sai_wait_for', ['pr', 'then'], ['pr', 'then']],
    ],
  )
  const send = AGENT_TOOLS.find((t) => t.name === 'sai_send')!.description
  assert.ok(send.indexOf('使う場面') < send.indexOf('1 ターンに'), '使う場面を先に、制限は後ろに書く')
  assert.match(send, /1 行目を「#N に着手してください。」だけ/, '着手の頼み方（#624。1 行目がこの形のときだけ要約される）')
})

test('sai_loop_next: 送り元・action・秒・申し送りを送り、次にどうなるかを言葉で返す。上限や目的は引数に無い（#634）', async () => {
  assert.deepEqual(LOOP_TOOLS.map((t) => [t.name, Object.keys(t.inputSchema.properties), t.inputSchema.required]), [['sai_loop_next', ['action', 'seconds', 'note'], ['action']]])
  seen.length = 0
  loopReply = { status: 200, body: { status: 'running', round: 2, max_rounds: 10, next_in_s: 300 } }
  const go = await agentTool('sai_loop_next', { action: 'continue', seconds: 300, note: 'CI を待つ', max_rounds: 99 }, base, 'A1@r', tokenFile)
  assert.match(go.content[0]!.text, /300 秒後に次の周（3 \/ 10）を起こします。待たずにこのターンを終えてください/)
  assert.deepEqual(JSON.parse(seen[0]!.body), { from: 'A1@r', action: 'continue', note: 'CI を待つ', seconds: 300 }, '知らない引数（上限など）は送らない')
  assert.equal(seen[0]!.token, 'secret-token')

  loopReply = { status: 200, body: { status: 'running', round: 10, max_rounds: 10 } }
  assert.match((await agentTool('sai_loop_next', { action: 'continue', note: 'x' }, base, 'A1@r', tokenFile)).content[0]!.text, /上限の 10 周に達した/)
  loopReply = { status: 200, body: { status: 'done', round: 3, max_rounds: 10 } }
  assert.match((await agentTool('sai_loop_next', { action: 'done', note: '0 件' }, base, 'A1@r', tokenFile)).content[0]!.text, /ループを終わりにしました/)
  loopReply = { status: 200, body: { status: 'paused', round: 3, max_rounds: 10, next_in_s: 60 } }
  assert.match((await agentTool('sai_loop_next', { action: 'continue', note: 'x' }, base, 'A1@r', tokenFile)).content[0]!.text, /人が一時停止している/)
  loopReply = { status: 409, body: { error: 'このターンはループの周ではありません' } }
  const refused = await agentTool('sai_loop_next', { action: 'done', note: 'x' }, base, 'A1@r', tokenFile)
  assert.equal(refused.isError, true)
  assert.match(refused.content[0]!.text, /ループの周ではありません/)
})

test('sai_wait_for: 送り元・PR の番号・起きたときにやることだけを送る。預かった・もう終わっている・断られたを言葉で返す（#732）', async () => {
  const tool = AGENT_TOOLS.find((t) => t.name === 'sai_wait_for')!
  assert.deepEqual([Object.keys(tool.inputSchema.properties), tool.inputSchema.required], [['pr', 'then'], ['pr', 'then']], '長さ・間隔・回数・リポジトリは引数に無い')
  seen.length = 0
  waitForReply = { status: 200, body: { wait: { id: 'w1', repo: 'o/r', pr: 12, then: '報告する', status: 'waiting', since: '2026-10-07T00:00:00.000Z', deadline: '2026-10-07T02:00:00.000Z' }, left: 1 } }
  const held = await agentTool('sai_wait_for', { pr: 12, then: '報告する', repo: 'evil/other', max_minutes: 999 }, base, 'A1@r', tokenFile)
  assert.equal(held.isError, undefined)
  assert.match(held.content[0]!.text, /預かりました。PR #12 の CI が終わったら（通っても落ちても）1 回だけ起こします/)
  assert.match(held.content[0]!.text, /待たずにこのターンを終えてください（あと 1 件預けられます）/)
  const sent = seen.at(-1)!
  assert.deepEqual([sent.method, sent.url, sent.token !== ''], ['POST', '/api/agent/wait-for', true])
  assert.deepEqual(JSON.parse(sent.body), { from: 'A1@r', pr: 12, then: '報告する' }, '余計な引数は送らない')

  waitForReply = { status: 200, body: { result: 'failure', failing: ['node (test)'], left: 2 } }
  const done = await agentTool('sai_wait_for', { pr: 12, then: '報告する' }, base, 'A1@r', tokenFile)
  assert.match(done.content[0]!.text, /預かっていません。もう終わっています: CI が落ちました（落ちたチェック: node \(test\)）/)

  waitForReply = { status: 429, body: { error: '同時に待てるのは 2 件までです（いま 2 件）' } }
  const refused = await agentTool('sai_wait_for', { pr: 13, then: '報告する' }, base, 'A1@r', tokenFile)
  assert.equal(refused.isError, true)
  assert.match(refused.content[0]!.text, /預かれませんでした: 同時に待てるのは 2 件まで/)
})

