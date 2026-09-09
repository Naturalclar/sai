import { test } from 'node:test'
import assert from 'node:assert/strict'
import { showProcessOption } from './replyOptions.ts'

test('別経路が使えなければ「端末を使わず送る」を出さない', () => {
  assert.equal(showProcessOption({ canProcess: false }), false)
})

test('resume または queue が使える場合は選択肢を出す', () => {
  assert.equal(showProcessOption({ canProcess: true }), true)
})
