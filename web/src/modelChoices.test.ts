import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLAUDE_ALIASES, MODEL_LABEL_MAX, modelChoices, shortModel } from './modelChoices.ts'

test('modelChoices: 出てきたモデルが先、Claude なら別名を足す、重複は除く', () => {
  assert.deepEqual(modelChoices('claude', ['claude-opus-5'], ''), ['claude-opus-5', ...CLAUDE_ALIASES])
  assert.deepEqual(modelChoices('claude', [], ''), CLAUDE_ALIASES)
  assert.deepEqual(modelChoices('claude', ['opus'], ''), ['opus', 'fable', 'sonnet', 'haiku'], '別名が出てきていれば重ねない')
})

test('modelChoices: Codex には別名を足さない。いまの値は一覧に無くても入る', () => {
  assert.deepEqual(modelChoices('codex', ['gpt-5.6-sol'], ''), ['gpt-5.6-sol'])
  assert.deepEqual(modelChoices('codex', ['gpt-5.6-sol'], 'o3'), ['gpt-5.6-sol', 'o3'])
  assert.deepEqual(modelChoices('codex', [], ''), [], '何も無ければ空')
  assert.deepEqual(modelChoices('unknown', ['x'], ''), ['x'])
})

test('shortModel: claude の正式名は一族の名前だけにする', () => {
  assert.equal(shortModel('claude-opus-5'), 'opus')
  assert.equal(shortModel('claude-sonnet-5'), 'sonnet')
  assert.equal(shortModel('claude-haiku-4-5-20251001'), 'haiku')
  assert.equal(shortModel('claude-fable-5-1'), 'fable')
  assert.equal(shortModel('opus'), 'opus', '別名はそのまま')
})

test('shortModel: 一族が分からないものは長ければ切る', () => {
  assert.equal(shortModel('qwen3:8b'), 'qwen3:8b')
  assert.equal(shortModel('gpt-5.6-sol'), 'gpt-5.6-sol')
  assert.equal(shortModel('a'.repeat(MODEL_LABEL_MAX)), 'a'.repeat(MODEL_LABEL_MAX), 'ちょうどなら切らない')
  const long = shortModel('a'.repeat(MODEL_LABEL_MAX + 1))
  assert.equal(long.length, MODEL_LABEL_MAX)
  assert.ok(long.endsWith('…'))
  assert.equal(shortModel('  opus  '), 'opus', '前後の空白は落とす')
  assert.equal(shortModel(''), '')
  assert.equal(shortModel('claude-nosuch-1'), 'claude-nosuch…', '知らない一族は切るだけ')
})
