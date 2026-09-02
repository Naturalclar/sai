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

test('待ちの行は待ちの発言になり、後に同じセッションの行が来ていれば resolved', () => {
  const wait = row(1, { event: 'PermissionRequest', text: '許可待ち: Bash: ls', user_text: '' })
  const open = toUtterances([row(0), wait])
  assert.equal(open.length, 2)
  assert.deepEqual([open[1]!.waiting, open[1]!.resolved, open[1]!.text, open[1]!.speaker], [true, false, '許可待ち: Bash: ls', 'claude'])

  const closed = toUtterances([row(0), wait, row(2)])
  assert.equal(closed[1]!.resolved, true)

  // 別セッションの行では解消しない
  const other = toUtterances([row(0), wait, row(2, { session: 's2' })])
  assert.equal(other[1]!.resolved, false)
})

test('再開（UserPromptSubmit）の行はバブルにしないが、待ちの解消にはなる', () => {
  const us = toUtterances([row(0, { event: 'PermissionRequest', text: '許可待ち: Bash: ls', user_text: '' }), row(1, { event: 'UserPromptSubmit', text: '', user_text: '' })])
  assert.equal(us.length, 1)
  assert.equal(us[0]!.resolved, true)
  const days = groupRows([row(0), row(1, { event: 'UserPromptSubmit', text: '', user_text: '' })])
  assert.equal(days[0]!.groups[0]!.items.length, 1)
})
