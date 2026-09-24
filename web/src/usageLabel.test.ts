import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shortTokens, usageLabel, usageLoud, usageTitle } from './usageLabel.ts'
import type { TurnUsage } from '../../shared/turnUsage.ts'

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  model: 'claude-opus-5',
  input_tokens: 10,
  output_tokens: 39,
  cache_read_input_tokens: 17582,
  cache_creation_input_tokens: 8431,
  cost_usd: 0.0197672,
  duration_ms: 1297,
  num_turns: 1,
  denials: 0,
  is_error: false,
  ...over,
})

test('shortTokens: 4 桁から k、7 桁から M', () => {
  assert.equal(shortTokens(0), '0')
  assert.equal(shortTokens(999), '999')
  assert.equal(shortTokens(1234), '1.2k')
  assert.equal(shortTokens(12345), '12k')
  assert.equal(shortTokens(1_234_567), '1.2M')
  assert.equal(shortTokens(12_345_678), '12M')
})

test('usageLabel: 合計（キャッシュを含む）を出し、断られたツールがあれば添える', () => {
  assert.equal(usageLabel(usage()), '26k トークン')
  assert.equal(usageLabel(usage({ denials: 2 })), '26k トークン・未許可 2')
})

test('usageLoud: 断られた・エラーで終わったときだけ目立たせる', () => {
  assert.equal(usageLoud(usage()), false)
  assert.equal(usageLoud(usage({ denials: 1 })), true)
  assert.equal(usageLoud(usage({ is_error: true })), true)
})

test('usageTitle: 内訳・ターン数・時間・モデルを出し、費用はここだけに出す', () => {
  const t = usageTitle(usage())
  assert.match(t, /入力 10 \/ 出力 39 \/ キャッシュ読み 17,582 \/ キャッシュ作成 8,431/)
  assert.match(t, /1 ターン・1\.3 秒/)
  assert.match(t, /\$0\.0198/)
  assert.match(t, /claude-opus-5/)
  // 費用はタグの文字には出さない（定額プランでは実際に請求されるものではない）
  assert.doesNotMatch(usageLabel(usage()), /\$/)
  // 分をまたぐ長いターン
  assert.match(usageTitle(usage({ duration_ms: 125_000 })), /2 分 5 秒/)
  // 繰り上がりの境目（#436）。別々に丸めていたころは `1 分 60 秒` / `60 秒` になっていた
  assert.match(usageTitle(usage({ duration_ms: 119_600 })), /2 分 0 秒/)
  assert.match(usageTitle(usage({ duration_ms: 59_600 })), /1 分 0 秒/)
  assert.match(usageTitle(usage({ duration_ms: 59_400 })), /・59 秒/)
  assert.match(usageTitle(usage({ duration_ms: 9_960 })), /10\.0 秒/, '10 秒未満は 0.1 秒まで')
  assert.match(usageTitle(usage({ duration_ms: 60_000 })), /1 分 0 秒/)
  assert.match(usageTitle(usage({ duration_ms: 0 })), /・0 秒/)
  // 断られた・エラーは文で出す
  assert.match(usageTitle(usage({ denials: 2, is_error: true })), /未許可で断られたツール 2 件/)
  assert.match(usageTitle(usage({ is_error: true })), /エラーで終わった/)
})
