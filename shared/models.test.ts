import { test } from 'node:test'
import assert from 'node:assert/strict'
import { opencodeModels } from './models.ts'

// `GET /config/providers?directory=…` の応答そのままの形（1.18.30）
const PROVIDERS = {
  providers: [
    { id: 'openai', name: 'OpenAI', models: { 'gpt-6-astra': { id: 'gpt-6-astra', name: 'GPT-6 Astra' } } },
    { id: 'ollama', name: 'Ollama', models: { 'qwen3:8b': { id: 'qwen3:8b', name: 'Qwen3 8B (local)' } } },
  ],
  default: { openai: 'gpt-6-astra', ollama: 'qwen3:8b' },
}

test('opencodeModels: provider/model を出てきた順に返す（メタに保存する形と同じ）', () => {
  assert.deepEqual(opencodeModels(PROVIDERS), ['openai/gpt-6-astra', 'ollama/qwen3:8b'])
})

test('opencodeModels: 形の違う応答・空は落とす', () => {
  assert.deepEqual(opencodeModels(null), [])
  assert.deepEqual(opencodeModels({ error: 'unauthorized' }), [])
  assert.deepEqual(opencodeModels({ providers: [{ name: 'id が無い', models: { a: {} } }] }), [])
  assert.deepEqual(opencodeModels({ providers: [{ id: 'p' }] }), [], 'models が無ければ何も出さない')
  // 同じ provider/model が 2 回出てきても 1 つ
  assert.deepEqual(opencodeModels({ providers: [{ id: 'p', models: { m: {} } }, { id: 'p', models: { m: {}, n: {} } }] }), ['p/m', 'p/n'])
})
