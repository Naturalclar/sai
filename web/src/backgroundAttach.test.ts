import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachCommand, backgroundNote } from './backgroundAttach.ts'

test('attachCommand / backgroundNote: 状態ごとの説明（#462）', () => {
  const bg = { attach: '5738db0d', live: true, status: 'waiting' }
  assert.equal(attachCommand(bg), 'claude attach 5738db0d')
  assert.match(backgroundNote(bg), /許可・質問を待っています/)
  assert.match(backgroundNote({ ...bg, status: 'busy' }), /回っています/)
  assert.match(backgroundNote({ ...bg, status: 'idle' }), /止めてから続けます/)
  assert.match(backgroundNote({ ...bg, live: false, status: '' }), /起こし直せます/)
})
