import { test } from 'node:test'
import assert from 'node:assert/strict'
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
