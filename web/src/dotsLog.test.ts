import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DotsConversation } from '../../shared/dots.ts'
import { dotsTarget, dotsTimeline, dotsTitle } from './dotsLog.ts'

const conv = (id: string, updated: string, text = '依頼'): DotsConversation => ({
  id,
  started_at: updated,
  updated_at: updated,
  requests: [{ message: { type: 'message', id: `m-${id}`, conversation_id: id, request_id: `r-${id}`, source: 'sai-human', at: updated, text }, state: 'queued', replies: [] }],
  orphans: [],
  imported: false,
})

test('並びは古いものが上、新しく動いたものが下', () => {
  assert.deepEqual(dotsTimeline([conv('b', '2026-11-05T10:00:00Z'), conv('a', '2026-11-05T09:00:00Z')]).map((c) => c.id), ['a', 'b'])
})

test('題名は最初の投稿の空でない 1 行目を 40 字で切る', () => {
  assert.equal(dotsTitle(conv('a', 'x', '\n  予定を並べて\n続き')), '予定を並べて')
  assert.equal(dotsTitle(conv('a', 'x', 'あ'.repeat(41))), `${'あ'.repeat(40)}…`)
  assert.equal(dotsTitle({ ...conv('a', 'x'), requests: [] }), '（題名なし）')
})

test('送り先: 無い会話は新しい会話に落とす。送った直後でまだ一覧に無い会話は残す', () => {
  const list = [conv('a', 'x')]
  assert.equal(dotsTarget(null, list, null), null)
  assert.equal(dotsTarget('a', list, null), list[0])
  assert.equal(dotsTarget('gone', list, null), null)
  assert.equal(dotsTarget('new', list, 'new'), 'new')
})

test('題名: dots が付けた会話の名前があればそれを使う', () => {
  const c = conv('a', 'x', '最初の質問')
  c.requests[0]!.message.thread = '週末の予定'
  assert.equal(dotsTitle(c), '週末の予定')
})
