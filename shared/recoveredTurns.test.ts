import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedRow } from './types.ts'
import { applyRecovered, gapKey, tsLike, turnGaps } from './recoveredTurns.ts'

const base = { agent: 'claude', repo: 'dev', session: 'S1', session_source: 'payload', branch: 'main', cwd: '/w' } as const
const input = (ts: string, text = '着手して', over: Partial<FeedRow> = {}): FeedRow => ({ ...base, ts, event: 'UserPromptSubmit', user_text: text, text: '', ...over }) as FeedRow
const stop = (ts: string, text = '終わりました', over: Partial<FeedRow> = {}): FeedRow => ({ ...base, ts, event: 'Stop', user_text: '着手して', text, ...over }) as FeedRow
const local = () => false

test('turnGaps: 入力の行のあとにターン完了の行が無いところと、本文が空のターン完了の行を拾う（#614）', () => {
  const rows = [
    input('2026-10-01T11:00:00+09:00'),
    stop('2026-10-01T11:05:00+09:00'),
    input('2026-10-01T11:34:40+09:00', '#583 に着手して'),
    // 待ちの行・入力の無い合図は関係ない
    { ...base, ts: '2026-10-01T11:40:00+09:00', event: 'PermissionRequest', text: '許可待ち: Bash: ls', user_text: '' } as FeedRow,
    { ...base, ts: '2026-10-01T11:40:05+09:00', event: 'UserPromptSubmit', text: '', user_text: '' } as FeedRow,
    input('2026-10-01T15:56:34+09:00', '#614 に着手して'),
    stop('2026-10-01T16:10:00+09:00', ''),
    input('2026-10-01T17:00:00+09:00', 'マージして'),
  ]
  const gaps = turnGaps(rows, local)
  assert.deepEqual(gaps.map((g) => [g.kind, g.kind === 'missing' ? g.input.user_text : g.row.ts, g.kind === 'missing' ? g.latest : g.input?.user_text]), [
    ['missing', '#583 に着手して', false],
    ['empty', '2026-10-01T16:10:00+09:00', '#614 に着手して'],
    ['missing', 'マージして', true],
  ])
  assert.equal(new Set(gaps.map(gapKey)).size, 3)
})

test('turnGaps: セッション単位で見る（別の worktree に載ったターン完了も数える）。Claude・このマシン・ID の取れた行だけ', () => {
  const moved = [input('2026-10-01T11:00:00+09:00'), stop('2026-10-01T11:05:00+09:00', '終わり', { repo: 'other' })]
  assert.deepEqual(turnGaps(moved, local), [])
  assert.deepEqual(turnGaps([input('2026-10-01T11:00:00+09:00', 'x', { agent: 'codex' })], local), [])
  assert.deepEqual(turnGaps([input('2026-10-01T11:00:00+09:00', 'x', { session_source: 'synth' })], local), [])
  assert.deepEqual(turnGaps([input('2026-10-01T11:00:00+09:00', 'x', { host: 'mini' })], (h) => h === 'mini'), [])
})

test('applyRecovered: 補った行を ts 順に足し、空の行は写しに本文を載せる。元の行は書き換えない。補うものが無ければ同じ配列', () => {
  const a = input('2026-10-01T11:34:40+09:00', '#583 に着手して')
  const b = input('2026-10-01T15:56:34+09:00', '#614 に着手して')
  const empty = stop('2026-10-01T16:10:00+09:00', '')
  const rows = [a, b, empty]
  const gaps = turnGaps(rows, local)
  assert.equal(applyRecovered(rows, gaps, new Map()), rows)
  const resolved = new Map([
    [gapKey(gaps[0]!), { text: 'PR #610 です', endedMs: Date.parse('2026-10-01T02:45:10.500Z') }],
    [gapKey(gaps[1]!), { text: 'PR #616 です', endedMs: 0 }],
  ])
  const out = applyRecovered(rows, gaps, resolved)
  assert.deepEqual(out.map((r) => [r.ts, r.event, r.text, r.recovered]), [
    ['2026-10-01T11:34:40+09:00', 'UserPromptSubmit', '', undefined],
    ['2026-10-01T11:45:10+09:00', 'Stop', 'PR #610 です', true],
    ['2026-10-01T15:56:34+09:00', 'UserPromptSubmit', '', undefined],
    ['2026-10-01T16:10:00+09:00', 'Stop', 'PR #616 です', true],
  ])
  assert.equal(out[1]!.user_text, '#583 に着手して', '入力は入力の行のもの（返答の引き当てに使う）')
  assert.equal(empty.text, '', '元の行は書き換えない')
  assert.equal(empty.recovered, undefined)
})

test('tsLike: 行の ts と同じオフセット・秒までにする', () => {
  assert.equal(tsLike(Date.parse('2026-10-01T02:45:10.500Z'), '2026-10-01T11:34:40+09:00'), '2026-10-01T11:45:10+09:00')
  assert.equal(tsLike(Date.parse('2026-10-01T02:45:10.500Z'), '2026-10-01T02:34:40+00:00'), '2026-10-01T02:45:10+00:00')
  assert.equal(tsLike(Date.parse('2026-10-01T02:45:10.500Z'), '2026-09-30T19:34:40-07:00'), '2026-09-30T19:45:10-07:00')
})
