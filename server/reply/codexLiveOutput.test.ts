import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexLiveOutputs, LIVE_COMMANDS_MAX, LIVE_OUTPUT_MAX_CHARS } from './codexLiveOutput.ts'

test('CodexLiveOutputs: コマンドごとに末尾だけ持ち、捨てた字数を数える（#846）', () => {
  const live = new CodexLiveOutputs()
  live.start('t', 'a', 'make', '2026-11-22T00:00:00.000Z')
  const chunk = 'x'.repeat(1000) + '\n'
  const n = Math.ceil((LIVE_OUTPUT_MAX_CHARS * 3) / chunk.length)
  for (let i = 0; i < n; i++) live.append('t', 'a', chunk)
  live.append('t', 'a', 'おわり')
  const [got] = live.of('t')
  assert.ok(got)
  assert.equal(got.text.length, LIVE_OUTPUT_MAX_CHARS, '上限の字数だけ')
  assert.ok(got.text.endsWith('おわり'), '新しい方を残す')
  assert.equal(got.dropped + got.text.length, n * chunk.length + 'おわり'.length, '捨てた字数と残した字数で全部')
})

test('CodexLiveOutputs: 同時にためるのは上限の本数まで。終わった項目・スレッドは捨てる（#846）', () => {
  const live = new CodexLiveOutputs()
  for (let i = 0; i < LIVE_COMMANDS_MAX + 2; i++) live.start('t', `i${i}`, `c${i}`, '')
  assert.equal(live.of('t').length, LIVE_COMMANDS_MAX)
  live.append('t', `i${LIVE_COMMANDS_MAX}`, '上限を超えた分')
  assert.equal(live.of('t').some((c) => c.text), false)
  // 同じ項目の始まりがもう一度届いても、ためた分を消さない
  live.append('t', 'i0', 'abc')
  live.start('t', 'i0', 'c0', '')
  assert.equal(live.of('t')[0]?.text, 'abc')
  live.end('t', 'i0')
  assert.equal(live.of('t').some((c) => c.itemId === 'i0'), false)
  live.start('u', 'j', 'c', '')
  live.clearThread('t')
  assert.deepEqual(live.of('t'), [])
  assert.equal(live.of('u').length, 1)
  live.clear()
  assert.deepEqual(live.of('u'), [])
})
