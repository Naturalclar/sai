import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DIGEST_PROVIDERS, isDigestModel, isDigestProvider } from './digestSettings.ts'

test('isDigestProvider: claude と openai だけ', () => {
  assert.deepEqual([...DIGEST_PROVIDERS], ['claude', 'openai'])
  assert.equal(isDigestProvider('claude'), true)
  assert.equal(isDigestProvider('openai'), true)
  for (const bad of ['gemini', '', 'Claude', 1, null, undefined]) assert.equal(isDigestProvider(bad), false, String(bad))
})

test('isDigestModel: 空は口の既定。形は返信のモデルと同じ検査で、- で始まる名前（CLI の引数に化ける）は受けない', () => {
  for (const ok of ['', 'haiku', 'claude-haiku-4-5', 'qwen3:8b', 'library/model:tag', 'fable[1m]']) assert.equal(isDigestModel(ok), true, ok)
  for (const bad of ['--dangerously-skip-permissions', '-m', ' haiku', 'a b', 'a'.repeat(65), 1, null, undefined]) assert.equal(isDigestModel(bad), false, String(bad))
})
