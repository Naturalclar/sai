import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authCheckNote } from './claudeAuthNote.ts'

test('authCheckNote: 確かめ直した結果を 1 行で。分からないときは「切れている」とも「できている」とも言わない', () => {
  assert.equal(authCheckNote({ kind: 'idle' }), '')
  assert.equal(authCheckNote({ kind: 'asking' }), '確かめています…')
  assert.match(authCheckNote({ kind: 'done', loggedIn: true }), /ログインできています/)
  assert.equal(authCheckNote({ kind: 'done', loggedIn: false }), 'まだ切れています')
  assert.match(authCheckNote({ kind: 'done', loggedIn: null }), /分かりませんでした/)
  assert.match(authCheckNote({ kind: 'error', message: 'HTTP 403' }), /HTTP 403/)
})
