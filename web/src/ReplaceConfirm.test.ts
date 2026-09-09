import { test } from 'node:test'
import assert from 'node:assert/strict'
import { showProcessOption } from './replyOptions.ts'

test('開いている Codex では「別プロセスで送る」を出さない（#160）', () => {
  assert.equal(showProcessOption({ canProcess: false }), false)
})

test('別プロセスで再開できる場合は選択肢を出す', () => {
  assert.equal(showProcessOption({ canProcess: true }), true)
})
