import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QUEUED_KEY_CHARS, queuedKey, queuedTextArrived } from './codexQueue.ts'

const SINCE = Date.parse('2026-09-22T04:37:17.000Z')
const line = (timestamp: string, type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload })
/** 届いたときに実際に載る形（2026-09-22 の `432を対応して` の行と同じ） */
const userItem = (timestamp: string, text: string) =>
  line(timestamp, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })

test('queuedTextArrived: 送ったあとに人の入力として載っていれば届いた', () => {
  assert.equal(queuedTextArrived([userItem('2026-09-22T04:37:17.503Z', '432を対応して')], '432を対応して', SINCE), true)
})

test('queuedTextArrived: 送る前に同じ文があっても数えない（前のターンの「マージして」を拾わない）', () => {
  const lines = [userItem('2026-09-22T04:30:00.000Z', 'マージして')]
  assert.equal(queuedTextArrived(lines, 'マージして', SINCE), false)
})

test('queuedTextArrived: 何か書かれただけ（返答・ツール）では届いたことにしない', () => {
  // mtime で見ていたころは、これで「届いた」になっていた
  const lines = [
    line('2026-09-22T04:37:20.000Z', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '432を対応して' }] }),
    line('2026-09-22T04:37:21.000Z', 'event_msg', { type: 'token_count' }),
  ]
  assert.equal(queuedTextArrived(lines, '432を対応して', SINCE), false)
})

test('queuedTextArrived: 古い形（event_msg の user_message）も読む', () => {
  const lines = [line('2026-09-22T04:37:18.000Z', 'event_msg', { type: 'user_message', message: 'PR作成して' })]
  assert.equal(queuedTextArrived(lines, 'PR作成して', SINCE), true)
})

test('queuedTextArrived: since が秒に丸めてあっても、同じ秒のうちに載った入力は拾う', () => {
  assert.equal(queuedTextArrived([userItem('2026-09-22T04:37:16.400Z', 'やって')], 'やって', SINCE), true)
})

test('queuedTextArrived: 長い本文は頭だけ見比べる。空白・改行の揺れと NFD は揃える', () => {
  const long = 'あ'.repeat(QUEUED_KEY_CHARS) + '\n続き'
  assert.equal(queuedTextArrived([userItem('2026-09-22T04:37:18.000Z', long.replace('\n', ' '))], long, SINCE), true)
  const nfd = 'ください'.normalize('NFD')
  assert.equal(queuedTextArrived([userItem('2026-09-22T04:37:18.000Z', nfd)], 'ください', SINCE), true)
})

test('queuedTextArrived: 壊れた行・時刻の無い行は飛ばす。空の本文は届いたことにしない', () => {
  const lines = ['{"timestamp":"2026-09-22T04:37', JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] } })]
  assert.equal(queuedTextArrived(lines, 'x', SINCE), false)
  assert.equal(queuedKey('   '), '')
  assert.equal(queuedTextArrived([userItem('2026-09-22T04:37:18.000Z', 'なんでも')], '  ', SINCE), false)
})
