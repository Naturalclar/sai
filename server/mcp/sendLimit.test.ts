import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCP_SEND_MAX, MCP_SEND_WINDOW_MS, McpSendLimiter } from './sendLimit.ts'

test('McpSendLimiter: 呼んだ人ごとに、一定時間に MCP_SEND_MAX 回まで。時間が過ぎれば戻る', () => {
  let now = 1_000_000
  const limiter = new McpSendLimiter(() => now)
  for (let i = 0; i < MCP_SEND_MAX; i++) {
    assert.equal(limiter.refusal('me'), '')
    limiter.record('me')
  }
  assert.match(limiter.refusal('me'), /回まで/)
  assert.equal(limiter.refusal('other'), '', '別の人は別に数える')
  now += MCP_SEND_WINDOW_MS + 1
  assert.equal(limiter.refusal('me'), '')
})

test('McpSendLimiter: サーバを立て直しても枠を数え直さず、窓の外に出たものは読むときに捨てる（#440）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-mcp-sends-'))
  const path = join(dir, 'mcp-sends.json')
  try {
    let now = 5_000_000
    const before = new McpSendLimiter(() => now, path)
    for (let i = 0; i < MCP_SEND_MAX; i++) before.record('me@example')
    assert.notEqual(before.refusal('me@example'), '')
    const after = new McpSendLimiter(() => now, path)
    assert.notEqual(after.refusal('me@example'), '', '立て直しても 10 分 5 回の枠は埋まったまま')
    assert.equal(after.refusal('other@example'), '', 'ほかの人は数えない')
    now += MCP_SEND_WINDOW_MS + 1
    assert.equal(new McpSendLimiter(() => now, path).refusal('me@example'), '', '窓を過ぎてから起きたら空')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
