// 未読の印（#502）の判定。数えるのは返答（ターン完了）だけ・印の無いセッションは since まで読んだ扱い・既読は戻さない
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latestTurnMs, nextMark, readMarkOf, unreadCounts, unreadFromMark } from './unread.ts'
import type { FeedRow } from './types.ts'

const r = (ts: string, session: string, over: Partial<FeedRow> = {}): FeedRow =>
  ({ ts, session, repo: 'sai', agent: 'claude', event: 'Stop', text: 'できました', ...over }) as FeedRow
const ms = (ts: string) => Date.parse(ts)

test('印より新しい返答だけを数え、待ち・入力・終わりの行は数えない', () => {
  const rows = [
    r('2026-09-30T10:00:00+09:00', 'A'),
    r('2026-09-30T10:05:00+09:00', 'A'),
    r('2026-09-30T10:06:00+09:00', 'A', { event: 'UserPromptSubmit', text: '' }),
    r('2026-09-30T10:07:00+09:00', 'A', { event: 'PermissionRequest', text: '許可待ち: Bash: ls' }),
    r('2026-09-30T10:08:00+09:00', 'A', { event: 'SessionEnd', text: 'セッション終了: 会話をリセット（/clear）' }),
    r('2026-09-30T10:09:00+09:00', 'A'),
  ]
  const marks = { since: 0, sessions: { 'A@sai': ms('2026-09-30T10:00:00+09:00') } }
  assert.equal(unreadCounts(rows, marks).get('A@sai'), 2)
})

test('印の無いセッションは since まで読んだ扱い（入れた瞬間に過去を全部未読にしない）', () => {
  const rows = [r('2026-09-30T09:00:00+09:00', 'B'), r('2026-09-30T11:00:00+09:00', 'B')]
  const marks = { since: ms('2026-09-30T10:00:00+09:00'), sessions: {} }
  assert.equal(readMarkOf(marks, 'B@sai'), marks.since)
  assert.equal(unreadCounts(rows, marks).get('B@sai'), 1)
})

test('読み終えたセッションは入れない', () => {
  const rows = [r('2026-09-30T09:00:00+09:00', 'C')]
  assert.equal(unreadCounts(rows, { since: ms('2026-09-30T10:00:00+09:00'), sessions: {} }).has('C@sai'), false)
})

test('一番新しい返答の時刻は並びに依らない', () => {
  const rows = [r('2026-09-30T10:05:00+09:00', 'A'), r('2026-09-30T10:00:00+09:00', 'A'), r('2026-09-30T10:09:00+09:00', 'A', { event: 'PermissionRequest', text: '許可待ち: x' })]
  assert.equal(latestTurnMs(rows), ms('2026-09-30T10:05:00+09:00'))
  assert.ok(Number.isNaN(latestTurnMs([])))
})

test('既読は前にしか進めず、戻すのは「ここから未読にする」だけ', () => {
  assert.equal(nextMark(100, 200, false), 200)
  assert.equal(nextMark(200, 100, false), null) // 古い画面が巻き戻さない
  assert.equal(nextMark(200, 200, false), null)
  assert.equal(nextMark(200, 100, true), 100)
  assert.equal(nextMark(200, Number.NaN, true), null)
})

test('「ここから未読にする」はその発言の 1 秒前（同じ秒の発言を読んだ扱いにしない）', () => {
  const ts = '2026-09-30T10:05:00+09:00'
  const rows = [r(ts, 'A')]
  assert.equal(unreadCounts(rows, { since: 0, sessions: { 'A@sai': unreadFromMark(ts) } }).get('A@sai'), 1)
})
