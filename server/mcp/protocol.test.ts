import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MCP_CAP } from './access.ts'
import type { McpScope } from './access.ts'
import { handleRpc, MCP_VERSIONS, protocolVersionOk, textResult } from './protocol.ts'
import type { McpTool } from './protocol.ts'

const calls: string[] = []
const tools: McpTool[] = [
  { name: 'r', scope: 'read', description: '読む', inputSchema: { type: 'object' }, run: async (args) => (calls.push(`r:${JSON.stringify(args)}`), textResult('読んだ')) },
  { name: 's', scope: 'send', description: '送る', inputSchema: { type: 'object' }, run: async () => (calls.push('s'), textResult('送った')) },
  { name: 'boom', scope: 'read', description: '落ちる', inputSchema: { type: 'object' }, run: async () => { throw new Error('壊れた') } },
]
const read = new Set<McpScope>(['read'])
const rpc = (method: string, params?: unknown, id: unknown = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })

test('handleRpc: initialize は受ける版ならそのまま、知らない版なら一番新しい版を返す。ping', async () => {
  const got = (await handleRpc(rpc('initialize', { protocolVersion: '2025-06-18' }), tools, read)) as { result: { protocolVersion: string; capabilities: object } }
  assert.equal(got.result.protocolVersion, '2025-06-18')
  assert.deepEqual(got.result.capabilities, { tools: {} })
  const unknown = (await handleRpc(rpc('initialize', { protocolVersion: '1999-01-01' }), tools, read)) as { result: { protocolVersion: string } }
  assert.equal(unknown.result.protocolVersion, MCP_VERSIONS[0])
  assert.deepEqual(await handleRpc(rpc('ping', undefined, 'p'), tools, read), { jsonrpc: '2.0', id: 'p', result: {} })
})

test('handleRpc: 通知・応答・壊れた形は null（HTTP は 202）。知らない method は -32601', async () => {
  assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools, read), null)
  assert.equal(await handleRpc({ jsonrpc: '2.0', id: 1, result: {} }, tools, read), null)
  assert.equal(await handleRpc('x', tools, read), null)
  assert.equal(await handleRpc(rpc('initialize', {}, null), tools, read), null, 'id が null は要求ではない')
  const got = (await handleRpc(rpc('resources/list'), tools, read)) as { error: { code: number } }
  assert.equal(got.error.code, -32601)
})

test('handleRpc: 許されていないツールは一覧に出さず、呼ばれたら capability の名前を添えてツールのエラーで返す（実行しない）', async () => {
  calls.length = 0
  const list = (await handleRpc(rpc('tools/list'), tools, read)) as { result: { tools: { name: string }[] } }
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ['r', 'boom'],
  )
  const denied = (await handleRpc(rpc('tools/call', { name: 's', arguments: {} }), tools, read)) as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(denied.result.isError, true)
  assert.match(denied.result.content[0]!.text, new RegExp(MCP_CAP.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
  assert.deepEqual(calls, [], '許されていないツールは動かさない')

  const all = new Set<McpScope>(['read', 'send'])
  const sent = (await handleRpc(rpc('tools/call', { name: 's' }), tools, all)) as { result: { content: { text: string }[] } }
  assert.equal(sent.result.content[0]!.text, '送った')
  const readArgs = (await handleRpc(rpc('tools/call', { name: 'r', arguments: { id: 'x' } }), tools, read)) as { result: object }
  assert.ok(readArgs.result)
  assert.deepEqual(calls, ['s', 'r:{"id":"x"}'])

  const unknown = (await handleRpc(rpc('tools/call', { name: 'nope' }), tools, all)) as { error: { code: number } }
  assert.equal(unknown.error.code, -32602)
  const boom = (await handleRpc(rpc('tools/call', { name: 'boom' }), tools, all)) as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(boom.result.isError, true)
  assert.match(boom.result.content[0]!.text, /壊れた/)
})

test('protocolVersionOk: 無ければ通す。受ける版だけ通す', () => {
  assert.equal(protocolVersionOk(undefined), true)
  assert.equal(protocolVersionOk('2025-06-18'), true)
  assert.equal(protocolVersionOk('2024-11-05'), false)
  assert.equal(protocolVersionOk(['2025-06-18']), false)
})
