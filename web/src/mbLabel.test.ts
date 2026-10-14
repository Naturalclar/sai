import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mbLabel } from './mbLabel.ts'

test('mbLabel: 10MB 未満は小数 1 桁、以上は整数', () => {
  assert.equal(mbLabel(0), '0.0MB')
  assert.equal(mbLabel(300 * 1024), '0.3MB')
  assert.equal(mbLabel(9.95 * 1048576), '10.0MB')
  assert.equal(mbLabel(512 * 1048576), '512MB')
  assert.equal(mbLabel(612.4 * 1048576), '612MB')
})
