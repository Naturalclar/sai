import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, SettingsStore, nextAskOn } from './settings.ts'

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

test('SettingsStore: next_ask が無い settings.json は一言の入切に従う（#560 より前の形）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-settings-next-ask-'))
  try {
    const path = join(dir, 'settings.json')
    await writeFile(path, JSON.stringify({ digest: true }))
    assert.equal(nextAskOn(await new SettingsStore(path).get()), true, '一言を入にしていた人の案は止めない')
    await writeFile(path, JSON.stringify({ digest: false }))
    assert.equal(nextAskOn(await new SettingsStore(path).get()), false, '入にしていなかった人の本文を黙って送り始めない')
    await writeFile(path, JSON.stringify({ digest: false, next_ask: true }))
    assert.equal(nextAskOn(await new SettingsStore(path).get()), true, 'あればそちら')
    await writeFile(path, JSON.stringify({ digest: true, next_ask: 'yes' }))
    assert.equal(nextAskOn(await new SettingsStore(path).get()), true, '読めなければ一言に従う')

    // 読んだときに埋めない（#561 のレビュー）。ほかの設定を保存しても next_ask は書かれず、一言の入切に付いてくる
    await writeFile(path, JSON.stringify({ digest: true }))
    const store = new SettingsStore(path)
    await store.set({ persona: 'ISTJ' })
    assert.ok(!('next_ask' in JSON.parse(await readFile(path, 'utf-8'))), 'ファイルに固まらない')
    assert.equal(nextAskOn(await store.set({ digest: false })), false)
    assert.equal(nextAskOn(await store.set({ digest: true })), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
