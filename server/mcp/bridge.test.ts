// 呼ぶ側のマシンに置く stdio の中継（feed/mcp/sai-mcp.mjs。#312 の B）を本当に子プロセスで立て、偽の /mcp に中継させる
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { fileURLToPath } from 'node:url'

const BRIDGE = fileURLToPath(new URL('../../feed/mcp/sai-mcp.mjs', import.meta.url))

let server: Server
let url: string
const seen: { headers: IncomingHttpHeaders; body: { id?: unknown; method?: string } }[] = []

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { id?: unknown; method?: string }
      seen.push({ headers: req.headers, body })
      if (body.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' })
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } }))
      }
      if (body.method === 'notifications/initialized') {
        res.writeHead(202)
        return res.end()
      }
      if (body.method === 'tools/list') {
        // SSE で返すサーバにも対応する
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'sai_sessions' }] } })}\n\n`)
      }
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'MCP を使う許可がありません' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/mcp`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 中継を立てて行を流し込み、stdin を閉じて終わるまでの stdout の行を返す */
function runBridge(args: string[], lines: object[]): Promise<{ out: object[]; code: number | null; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf-8')))
    child.stderr.on('data', (b: Buffer) => (err += b.toString('utf-8')))
    child.on('close', (code) =>
      resolve({
        out: out
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as object),
        code,
        err,
      }),
    )
    // initialize の応答が返ってから次を送る（本物のクライアントと同じ順）
    const [first, ...rest] = lines
    if (!first) return child.stdin.end()
    child.stdin.write(JSON.stringify(first) + '\n')
    const wait = setInterval(() => {
      if (!out.includes('\n')) return
      clearInterval(wait)
      for (const l of rest) child.stdin.write(JSON.stringify(l) + '\n')
      child.stdin.end()
    }, 10)
  })
}

test('sai-mcp.mjs: stdin の JSON-RPC を /mcp に POST し、応答を stdout に書く。initialize で決まった版とセッション ID を以後に付け、通知には何も書かない（#312）', async () => {
  seen.length = 0
  const { out, code } = await runBridge(
    [url],
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sai_send' } },
    ],
  )
  assert.equal(code, 0)
  const byId = new Map(out.map((m) => [(m as { id: unknown }).id, m]))
  assert.equal(out.length, 3, '通知には応答を書かない')
  assert.deepEqual((byId.get(1) as { result: { protocolVersion: string } }).result.protocolVersion, '2025-06-18')
  assert.deepEqual((byId.get(2) as { result: { tools: { name: string }[] } }).result.tools, [{ name: 'sai_sessions' }], 'SSE の応答も 1 行にして書く')
  const denied = byId.get(3) as { error: { code: number; message: string } }
  assert.equal(denied.error.code, -32000)
  assert.match(denied.error.message, /HTTP 403 MCP を使う許可がありません/, 'JSON-RPC でない失敗は理由を添えたエラーにする')

  const first = seen.find((s) => s.body.method === 'initialize')!
  assert.match(String(first.headers.accept), /application\/json/)
  assert.match(String(first.headers.accept), /text\/event-stream/)
  assert.equal(first.headers['mcp-protocol-version'], undefined, 'initialize の前は版を付けない')
  const later = seen.filter((s) => s.body.method !== 'initialize')
  assert.equal(later.length, 3)
  for (const s of later) {
    assert.equal(s.headers['mcp-protocol-version'], '2025-06-18')
    assert.equal(s.headers['mcp-session-id'], 'sess-1')
  }
})

test('sai-mcp.mjs: SAI に届かなければ要求にはエラーを返す。URL が無ければ使い方を出して 2 で終わる', async () => {
  const unreachable = await runBridge(['http://127.0.0.1:1/mcp'], [{ jsonrpc: '2.0', id: 9, method: 'tools/list' }])
  const e = unreachable.out[0] as { id: number; error: { message: string } }
  assert.equal(e.id, 9)
  assert.match(e.error.message, /SAI に届きません/)

  const usage = await runBridge([], [])
  assert.equal(usage.code, 2)
  assert.match(usage.err, /使い方/)
})
