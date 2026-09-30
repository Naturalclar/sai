import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedRow } from '../../shared/types.ts'
import { withAgentReplies } from './agentReplies.ts'

const row = (ts: string, text: string, reply = false): FeedRow =>
  ({ ts, agent: 'claude', repo: 'r', branch: '', cwd: '', session: reply ? 'other' : 'me', event: 'Stop', text, ...(reply ? { agent_reply: { message_id: 'm', to_name: '相手', sent_at: ts } } : {}) }) as FeedRow

test('withAgentReplies: 返答を時刻の順に混ぜる。同じ時刻ならこのセッションの行が先。無ければ元の配列のまま（#588）', () => {
  const rows = [row('2026-10-01T01:21:00+09:00', '頼みました'), row('2026-10-01T01:50:00+09:00', '次')]
  assert.equal(withAgentReplies(rows, undefined), rows)
  assert.equal(withAgentReplies(rows, []), rows)
  const merged = withAgentReplies(rows, [row('2026-10-01T01:40:22+09:00', '着手しました', true), row('2026-10-01T01:50:00+09:00', '同じ秒', true)])
  assert.deepEqual(merged.map((r) => r.text), ['頼みました', '着手しました', '次', '同じ秒'])
})
