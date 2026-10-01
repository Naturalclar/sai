import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstUse } from './digestUsageOnce.ts'

test('firstUse: 同じ一言・同じ合図は 1 回だけ数える。鍵が無ければ数えない（#446）', () => {
  const seen = new Set<string>()
  assert.equal(firstUse(seen, 'S1@repo|2026-10-01T10:00:00+09:00', 'opened'), true)
  assert.equal(firstUse(seen, 'S1@repo|2026-10-01T10:00:00+09:00', 'opened'), false, '開け閉めのたびに増やさない')
  assert.equal(firstUse(seen, 'S1@repo|2026-10-01T10:00:00+09:00', 'next_ask_accepted'), true, '合図が違えば別')
  assert.equal(firstUse(seen, 'S1@repo|2026-10-01T11:00:00+09:00', 'opened'), true, '行が違えば別')
  assert.equal(firstUse(seen, '', 'opened'), false)
})
