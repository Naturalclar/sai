import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextAskChip } from './nextAskChip.ts'

test('nextAskChip: 入力欄が空のときだけ出す', () => {
  assert.equal(nextAskChip('マージして', ''), 'マージして')
  assert.equal(nextAskChip('マージして', '  '), 'マージして', '空白だけなら空とみなす')
  assert.equal(nextAskChip('マージして', 'マ'), '', '打ち始めたら引っ込む（打ちかけの続きに譲る）')
})

test('nextAskChip: 案が無ければ出さない', () => {
  assert.equal(nextAskChip(undefined, ''), '')
  assert.equal(nextAskChip('', ''), '')
  assert.equal(nextAskChip('   ', ''), '')
})

test('nextAskChip: 続きのチップと同じ規則で 1 行に切る', () => {
  const long = 'あ'.repeat(200)
  const label = nextAskChip(`${long}\n2 行目`, '')
  assert.ok(label.length < long.length)
  assert.ok(!label.includes('\n'))
})
