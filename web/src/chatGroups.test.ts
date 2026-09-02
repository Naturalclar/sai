import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedRow } from '../../shared/types.ts'
import { groupRows, toUtterances } from './chatGroups.ts'

// 時刻は Asia/Tokyo 固定のプロセスに依存しないよう、同じ日の中で分だけ動かす
const base = new Date('2026-09-02T03:00:00Z')
const at = (min: number) => new Date(base.getTime() + min * 60_000).toISOString()

function row(min: number, over: Partial<FeedRow> = {}): FeedRow {
  return { ts: at(min), agent: 'claude', repo: 'sai', branch: 'main', session: 's1', session_source: 'payload', cwd: '/x', event: 'Stop', text: '返答', ...over }
}

test('user_text があれば「自分」の発言が先に立ち、無ければエージェントの発言だけ', () => {
  const [mine, theirs] = toUtterances([row(0, { user_text: '頼み' })])
  assert.equal(mine?.speaker, 'me')
  assert.equal(mine?.text, '頼み')
  assert.equal(theirs?.speaker, 'claude')
  assert.equal(theirs?.text, '返答')

  const only = toUtterances([row(0), row(1, { user_text: '   ' })])
  assert.deepEqual(only.map((u) => u.speaker), ['claude', 'claude'])
})

test('同じ発言者が10分以内に続けば1つのグループ、10分空けば別のグループ', () => {
  const days = groupRows([row(0), row(9), row(19)])
  assert.equal(days.length, 1)
  const groups = days[0]!.groups
  assert.equal(groups.length, 2)
  assert.equal(groups[0]!.items.length, 2)
  assert.equal(groups[0]!.lastTs, at(9))
  assert.equal(groups[1]!.firstTs, at(19))
})

test('発言者かセッションが変わればグループを切る', () => {
  const days = groupRows([row(0, { user_text: '頼み' }), row(1), row(2, { session: 's2' })])
  const groups = days[0]!.groups
  assert.deepEqual(groups.map((g) => [g.speaker, g.session]), [['me', 's1'], ['claude', 's1'], ['claude', 's2']])
})

test('日付が変わったら日ごとの束を分け、グループも跨がない', () => {
  const days = groupRows([row(0), row(24 * 60)])
  assert.equal(days.length, 2)
  assert.notEqual(days[0]!.day, days[1]!.day)
  assert.equal(days[0]!.groups.length, 1)
  assert.equal(days[1]!.groups.length, 1)
})
