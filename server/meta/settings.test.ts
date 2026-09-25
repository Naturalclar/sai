import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, SettingsStore } from './settings.ts'

const DEFAULTS = { ...DEFAULT_SETTINGS }

test('SettingsStore: 無ければ既定（一言は切、口は claude、モデルは空）。set で重ねてファイルに残る', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-settings-'))
  try {
    const path = join(dir, 'settings.json')
    const store = new SettingsStore(path)
    assert.deepEqual(await store.get(), DEFAULTS)
    await store.set({ digest: true, digest_provider: 'openai', digest_model: 'qwen3:8b' })
    assert.deepEqual(await new SettingsStore(path).get(), { ...DEFAULTS, digest: true, digest_provider: 'openai', digest_model: 'qwen3:8b' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SettingsStore: 読めないキーはそのキーだけ既定に落とす（手で書き換えても、CLI の引数に化けるモデル名は通さない）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-settings-bad-'))
  try {
    const path = join(dir, 'settings.json')
    await writeFile(path, JSON.stringify({ persona: 'ISTJ', linear_workspace: 'acme', digest: 'yes', digest_provider: 'gemini', digest_model: '--dangerously-skip-permissions' }))
    assert.deepEqual(await new SettingsStore(path).get(), { ...DEFAULTS, persona: 'ISTJ', linear_workspace: 'acme' })
    await writeFile(path, '{ broken')
    assert.deepEqual(await new SettingsStore(path).get(), DEFAULTS)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SettingsStore: jev_auto は 0 か 0.5〜1 だけ読む（#499）。それ以外は既定の 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-settings-jev-'))
  try {
    const path = join(dir, 'settings.json')
    await writeFile(path, JSON.stringify({ jev_auto: 0.9 }))
    assert.equal((await new SettingsStore(path).get()).jev_auto, 0.9)
    for (const bad of [0.3, 2, '0.9', true]) {
      await writeFile(path, JSON.stringify({ jev_auto: bad }))
      assert.equal((await new SettingsStore(path).get()).jev_auto, 0, JSON.stringify(bad))
    }
    await writeFile(path, JSON.stringify({ jev: false, jev_auto: 0.9 }))
    assert.equal((await new SettingsStore(path).get()).jev_auto, 0, 'Jev を切っていれば自動も切')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
