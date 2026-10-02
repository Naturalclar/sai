import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayLabel, modelLabel, periodLabel, shareLabel, usdLabel } from './usageReportLabels.ts'

test('periodLabel: 1 日は「24 時間」（いまから 24 時間前まで。今日の 0 時からではない）', () => {
  assert.equal(periodLabel(1), '24 時間')
  assert.equal(periodLabel(7), '7 日')
  assert.equal(periodLabel(30), '30 日')
})

test('usdLabel: 0・1 セント未満・普通・100 ドル以上', () => {
  assert.equal(usdLabel(0), '$0')
  assert.equal(usdLabel(Number.NaN), '$0')
  assert.equal(usdLabel(0.004), '<$0.01')
  assert.equal(usdLabel(0.019), '$0.02')
  assert.equal(usdLabel(12.345), '$12.35')
  assert.equal(usdLabel(99.99), '$99.99')
  assert.equal(usdLabel(3256.94), '$3,257')
})

test('shareLabel: 0 でないのに 0% と出さない。1 を超えても 100%', () => {
  assert.equal(shareLabel(0), '0%')
  assert.equal(shareLabel(0.004), '<1%')
  assert.equal(shareLabel(0.224), '22%')
  assert.equal(shareLabel(1), '100%')
  assert.equal(shareLabel(1.2), '100%')
})

test('modelLabel / dayLabel', () => {
  assert.equal(modelLabel(''), '（不明）')
  assert.equal(modelLabel('claude-opus-5'), 'claude-opus-5')
  assert.equal(dayLabel('2026-10-02'), '10/2')
  assert.equal(dayLabel('壊れた日付'), '壊れた日付')
})
