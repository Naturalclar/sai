import { test } from 'node:test'
import assert from 'node:assert/strict'
import { queuedLabel, shouldQueue } from './replyQueue.ts'

test('shouldQueue: 処理中か、預かりが残っていれば預ける（先に預けたものを追い越さない。#305）', () => {
  assert.equal(shouldQueue(false, 0), false, '処理中でなく預かりも無ければ、今までどおりすぐ送る')
  assert.equal(shouldQueue(true, 0), true)
  assert.equal(shouldQueue(false, 2), true, '前のターンは終わったが、まだ回していない預かりがある（止めている間も）')
})

test('queuedLabel: 何番目かと、預けてからの経過', () => {
  assert.equal(queuedLabel(1, '3分'), '待機中（1 番目） · 3分')
  assert.equal(queuedLabel(2, ''), '待機中（2 番目）', '経過が出せなければ付けない')
})
