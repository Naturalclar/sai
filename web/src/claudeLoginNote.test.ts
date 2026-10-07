import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loginAcceptsCode, loginActive, loginNote } from './claudeLoginNote.ts'

const URL = 'https://auth.example/authorize?x=1'

test('loginActive: 手順が走っている間だけ状態を聞き続ける（終わった・失敗・最初は聞かない）', () => {
  assert.deepEqual((['idle', 'starting', 'waiting', 'sent', 'checking', 'done', 'failed'] as const).map((status) => loginActive({ status })), [false, true, true, true, true, false, false])
})

test('loginAcceptsCode: URL が出ていて子が待っている間だけ、コードの欄を出す', () => {
  assert.equal(loginAcceptsCode({ status: 'waiting', url: URL }), true)
  assert.equal(loginAcceptsCode({ status: 'sent', url: URL }), true)
  assert.equal(loginAcceptsCode({ status: 'waiting' }), false)
  assert.equal(loginAcceptsCode({ status: 'starting' }), false)
  assert.equal(loginAcceptsCode({ status: 'checking' }), false)
})

test('loginNote: 違うコードは貼り直しを促し、失敗は理由ごとに次の手を言う', () => {
  assert.equal(loginNote({ status: 'idle' }), '')
  assert.equal(loginNote({ status: 'waiting', url: URL }), '')
  assert.match(loginNote({ status: 'waiting', url: URL, note: 'invalid_code' }), /コードが違う/)
  assert.match(loginNote({ status: 'done' }), /ログインできました/)
  assert.match(loginNote({ status: 'failed', note: 'timeout' }), /時間切れです（10 分）/)
  assert.match(loginNote({ status: 'failed', note: 'logged_in' }), /もうログインできています/)
  assert.match(loginNote({ status: 'failed', note: 'unknown' }), /分からない/)
  assert.match(loginNote({ status: 'failed', note: 'spawn_failed' }), /PATH/)
  assert.match(loginNote({ status: 'failed', note: 'exited' }), /ログインできませんでした/)
  for (const note of ['no_url', 'unavailable'] as const) assert.match(loginNote({ status: 'failed', note }), /Mac の端末で claude auth login/)
})
