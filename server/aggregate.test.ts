import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedRow } from '../shared/types.ts'
import { aggregate, clip, facets, filterSessions, localDate, recentDates } from './aggregate.ts'

export function row(ts: Date, session: string, over: Partial<FeedRow> = {}): FeedRow {
  return {
    ts: ts.toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    agent: 'claude',
    repo: 'kanban',
    branch: 'main',
    session,
    session_source: 'payload',
    cwd: '/home/u/kanban',
    event: 'Stop',
    text: 'hi',
    user_text: 'やって',
    first_user_text: '',
    ...over,
  }
}

const min = (n: number) => n * 60_000

test('localDate は Asia/Tokyo で切る', () => {
  assert.equal(localDate('2026-09-02T00:30:00+09:00'), '2026-09-02')
  assert.equal(localDate('2026-09-01T16:30:00Z'), '2026-09-02', 'UTC 16:30 は JST の翌日')
  assert.equal(localDate('2026-09-01T14:30:00Z'), '2026-09-01')
  assert.equal(localDate('garbage-but-long'), 'garbage-bu')
})

test('recentDates は今日から新しい順', () => {
  const dates = recentDates(3, new Date('2026-09-01T16:00:00Z')) // JST 9/2 01:00
  assert.deepEqual(dates, ['2026-09-02', '2026-09-01', '2026-08-31'])
})

test('clip はコードポイントで数える', () => {
  assert.equal(clip('あ'.repeat(60), 60).length, 60)
  assert.equal(clip('あ'.repeat(61), 60), 'あ'.repeat(59) + '…')
  assert.equal(clip('😀'.repeat(5), 3), '😀😀…')
})

test('(セッション, リポジトリ) 単位にまとめて新しい順', () => {
  const base = new Date('2026-09-02T01:00:00Z')
  const rows = [
    row(base, 'A', { text: '第一声\n二行目', user_text: '', first_user_text: 'やりたいこと' }),
    row(new Date(base.getTime() + min(5)), 'A', { branch: 'feat', text: 'second', user_text: '' }),
    row(new Date(base.getTime() + min(60)), 'B', { agent: 'codex', text: 'codex says', user_text: '', session_source: 'synth' }),
  ]
  const sessions = aggregate(rows)
  assert.deepEqual(sessions.map((s) => s.id), ['B@kanban', 'A@kanban'])
  const a = sessions[1]!
  assert.equal(a.turns, 2)
  assert.equal(a.title, 'やりたいこと')
  assert.equal(a.repo, 'kanban')
  assert.equal(a.branch, 'feat')
  assert.deepEqual(a.branches, ['main', 'feat'])
  assert.equal(a.session_source, 'payload')
  assert.equal(a.date, '2026-09-02')
  const b = sessions[0]!
  assert.equal(b.title, 'codex says', 'first_user_text が無ければ最初の text の1行目')
  assert.equal(b.session_source, 'synth')
})

test('タイトルは一番新しい user_text に追従する（返信や端末での続きの指示で変わる）', () => {
  const base = new Date('2026-09-02T01:00:00Z')
  const first = [row(base, 'A', { user_text: '最初の指示', first_user_text: '最初の指示' })]
  assert.equal(aggregate(first)[0]!.title, '最初の指示')

  const replied = [...first, row(new Date(base.getTime() + min(5)), 'A', { user_text: '続きの指示\n2行目', first_user_text: '最初の指示' })]
  assert.equal(aggregate(replied)[0]!.title, '続きの指示', '1行目だけ')
  assert.equal(aggregate(replied)[0]!.title_full, '続きの指示')

  const blank = [...replied, row(new Date(base.getTime() + min(10)), 'A', { user_text: '  ', first_user_text: '最初の指示' })]
  assert.equal(aggregate(blank)[0]!.title, '続きの指示', 'user_text が空の行は飛ばす')

  const old = [row(base, 'B', { user_text: '', first_user_text: '古い行' }), row(new Date(base.getTime() + min(5)), 'B', { user_text: '', first_user_text: '古い行' })]
  assert.equal(aggregate(old)[0]!.title, '古い行', 'user_text が1行も無ければ first_user_text')
})

test('同じセッションIDでもリポジトリが違えば別エンティティ', () => {
  const base = new Date('2026-09-02T01:00:00Z')
  const sessions = aggregate([
    row(base, 'A', { text: 'kanban 側' }),
    row(new Date(base.getTime() + min(9)), 'A', { repo: 'other', text: 'other 側' }),
  ])
  assert.deepEqual(sessions.map((s) => s.id), ['A@other', 'A@kanban'])
  assert.deepEqual(sessions.map((s) => s.turns), [1, 1])
  assert.deepEqual(sessions.map((s) => s.repos), [['other'], ['kanban']])
})

test('タイトルは60文字で切る', () => {
  const s = aggregate([row(new Date(), 'A', { user_text: 'あ'.repeat(100) })])[0]!
  assert.equal(Array.from(s.title).length, 60)
  assert.ok(s.title.endsWith('…'))
  assert.equal(Array.from(s.title_full).length, 100)
})

test('絞り込みと候補', () => {
  const base = new Date('2026-09-02T01:00:00Z')
  const sessions = aggregate([
    row(base, 'A', { repo: 'x' }),
    row(base, 'B', { repo: 'y', agent: 'codex' }),
    row(new Date(base.getTime() - min(60 * 24)), 'C', { repo: 'x' }),
  ])
  const ids = (list: typeof sessions) => new Set(list.map((s) => s.id))
  assert.deepEqual(ids(filterSessions(sessions, 'x', '', '')), new Set(['A@x', 'C@x']))
  assert.deepEqual(ids(filterSessions(sessions, '', 'codex', '')), new Set(['B@y']))
  assert.deepEqual(ids(filterSessions(sessions, 'x', '', '2026-09-01')), new Set(['C@x']))
  assert.deepEqual(facets(sessions), { repos: ['x', 'y'], agents: ['claude', 'codex'], dates: ['2026-09-02', '2026-09-01'] })
})

test('session が空の行は unknown-<日付> にまとめる（リポジトリ別）', () => {
  const s = aggregate([row(new Date('2026-09-02T01:00:00Z'), '', { repo: 'r' })])[0]!
  assert.equal(s.id, 'unknown-2026-09-02@r')
})
