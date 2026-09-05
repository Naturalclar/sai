import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedRow } from '../shared/types.ts'
import { aggregate, clip, facets, filterSessions, localDate, recentDates, recordVersionOf } from './aggregate.ts'

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

test('待ちの行: 最後が待ちなら waiting にその text、ターン数と最後の発言には数えない', () => {
  const t0 = new Date('2026-09-02T01:00:00Z')
  const rows = [
    row(t0, 's1', { text: '始めた' }),
    row(new Date(t0.getTime() + min(1)), 's1', { event: 'PermissionRequest', text: '許可待ち: Bash: rm -rf node_modules', user_text: '' }),
  ]
  const [s] = aggregate(rows)
  assert.equal(s!.waiting, '許可待ち: Bash: rm -rf node_modules')
  assert.equal(s!.turns, 1)
  assert.equal(s!.last_text, '始めた', '待ちの行の text は「最後の発言」にしない')
  assert.equal(s!.end, rows[1]!.ts, '最終更新は待ち始めた時刻')
})

test('待ちの行: 後にターン完了か再開が来れば waiting は空', () => {
  const t0 = new Date('2026-09-02T01:00:00Z')
  const wait = row(new Date(t0.getTime() + min(1)), 's1', { event: 'PreToolUse', text: '質問: 赤か青か?', user_text: '' })
  const byStop = aggregate([row(t0, 's1'), wait, row(new Date(t0.getTime() + min(2)), 's1', { text: '青にした', user_text: '青' })])
  assert.equal(byStop[0]!.waiting, '')
  assert.equal(byStop[0]!.turns, 2)
  assert.equal(byStop[0]!.last_text, '青にした')
  assert.equal(byStop[0]!.title, '青', 'タイトルは最新の user_text（待ちの行は空なので飛ばす）')

  const byResume = aggregate([row(t0, 's1'), wait, row(new Date(t0.getTime() + min(2)), 's1', { event: 'UserPromptSubmit', text: '', user_text: '' })])
  assert.equal(byResume[0]!.waiting, '', '再開の行で解消')
  assert.equal(byResume[0]!.turns, 1, '再開の行はターンではない')
  assert.equal(byResume[0]!.last_text, 'hi')
})

test('入力の行（UserPromptSubmit + user_text）はターンに数えないが、タイトルはすぐ追従する', () => {
  const t0 = new Date('2026-09-02T01:00:00Z')
  const [s] = aggregate([
    row(t0, 's1', { user_text: '最初' }),
    row(new Date(t0.getTime() + min(1)), 's1', { event: 'UserPromptSubmit', text: '', user_text: '次の指示' }),
  ])
  assert.equal(s!.turns, 1)
  assert.equal(s!.title, '次の指示', '返答を待たずにタイトルが変わる')
  assert.equal(s!.last_text, 'hi', '最後の発言はターン完了の行のまま')
  assert.equal(s!.waiting, '')
})

test('待ちの行だけのセッションでも壊れない', () => {
  const [s] = aggregate([row(new Date('2026-09-02T01:00:00Z'), 's1', { event: 'Notification', text: '入力待ち', user_text: '', first_user_text: '頼み' })])
  assert.equal(s!.turns, 0)
  assert.equal(s!.last_text, '')
  assert.equal(s!.waiting, '入力待ち')
  assert.equal(s!.title, '頼み')
})

test('recordVersionOf は一番新しい行の v。無い行は 1（試作か古い record.py）、行が無ければ 0', () => {
  const t0 = new Date('2026-09-05T01:00:00Z')
  assert.equal(recordVersionOf([]), 0)
  assert.equal(recordVersionOf([row(t0, 's1')]), 1, 'fixture の行には v が無い = 旧形式')
  assert.equal(recordVersionOf([row(t0, 's1'), row(new Date(t0.getTime() + min(1)), 's1', { v: 2 })]), 2)
  assert.equal(recordVersionOf([row(t0, 's1', { v: 2 }), row(new Date(t0.getTime() + min(1)), 's2')]), 1, '新しい行が旧形式なら古い record.py が混ざっている')
})

test('model は一番新しいターン完了の行のもの、models は出てきた順の重複なし。無い行は数えない', () => {
  const base = new Date('2026-09-02T01:00:00Z')
  const [s] = aggregate([
    row(base, 'M', { model: 'claude-fable-5' }),
    row(new Date(base.getTime() + min(1)), 'M', { model: 'claude-opus-5' }),
    row(new Date(base.getTime() + min(2)), 'M', { event: 'PermissionRequest', text: '許可待ち', model: 'ignored' }),
    row(new Date(base.getTime() + min(3)), 'M'),
    row(new Date(base.getTime() + min(4)), 'M', { model: 'claude-fable-5' }),
  ])
  assert.equal(s!.model, 'claude-fable-5')
  assert.deepEqual(s!.models, ['claude-fable-5', 'claude-opus-5'], '待ちの行のモデルは見ない。同じモデルは1回')
  const [none] = aggregate([row(base, 'N')])
  assert.equal(none!.model, '')
  assert.deepEqual(none!.models, [])
})
