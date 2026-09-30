// 未読の線の位置と、既読を送るか（#502）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstUnreadKey, readToSend } from './unreadMarks.ts'
import type { Utterance } from './chatGroups.ts'
import type { FeedRow } from './api'

const u = (key: string, ts: string, over: Partial<Utterance> = {}, row: Partial<FeedRow> = {}): Utterance =>
  ({ key, speaker: 'agent', text: 'x', row: { ts, event: 'Stop', text: 'x', ...row } as FeedRow, ...over }) as Utterance
const ms = (ts: string) => Date.parse(ts)

test('印より新しい最初の返答の前に引く（自分の入力・待ち・区切りは飛ばす）', () => {
  const items = [
    u('a', '2026-09-30T10:00:00+09:00'),
    u('me', '2026-09-30T10:01:00+09:00', { speaker: 'me' }),
    u('w', '2026-09-30T10:02:00+09:00', { waiting: true }, { event: 'PermissionRequest', text: '許可待ち: x' }),
    u('b', '2026-09-30T10:03:00+09:00'),
    u('c', '2026-09-30T10:04:00+09:00'),
  ]
  assert.equal(firstUnreadKey(items, ms('2026-09-30T10:00:00+09:00')), 'b')
  assert.equal(firstUnreadKey(items, ms('2026-09-30T10:04:00+09:00')), '')
  assert.equal(firstUnreadKey(items, undefined), '')
})

test('一番新しい返答が印より新しいときだけ、同じ時刻は 1 度だけ送る', () => {
  assert.equal(readToSend(200, 100, 0, false), 200)
  assert.equal(readToSend(200, 200, 0, false), null)
  assert.equal(readToSend(200, 100, 200, false), null) // 送ったばかり
  assert.equal(readToSend(300, 100, 200, false), 300) // 新しい返答が届いた
  assert.equal(readToSend(200, undefined, 0, false), 200)
  assert.equal(readToSend(Number.NaN, 100, 0, false), null)
})

test('「ここから未読にする」のあとは離れるまで送らない', () => {
  assert.equal(readToSend(200, 100, 0, true), null)
})
