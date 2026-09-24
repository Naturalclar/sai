import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachCommand, backgroundNote } from './backgroundAttach.ts'

test('attachCommand / backgroundNote: 状態ごとの説明（#462）', () => {
  const bg = { attach: '5738db0d', live: true, status: 'waiting' }
  assert.equal(attachCommand(bg), 'claude attach 5738db0d')
  assert.match(backgroundNote(bg), /許可・質問を待っています/)
  assert.match(backgroundNote({ ...bg, status: 'busy' }), /回っています/)
  // 2.1.278 の `working`（生きているだけ。ターンが回っているかは分からない）
  assert.match(backgroundNote({ ...bg, status: 'working' }), /端末で開いて打ってください/)
  assert.match(backgroundNote({ ...bg, live: false, status: '' }), /起こし直せます/)
})
