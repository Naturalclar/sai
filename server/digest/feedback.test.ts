import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeedbackStore } from './feedback.ts'
import type { DigestFeedbackEntry } from './feedback.ts'

const entry = (over: Partial<DigestFeedbackEntry> = {}): DigestFeedbackEntry => ({
  key: 'S1@repo|2026-09-13T10:00:00+09:00',
  summary: 'PR #284 作成。マージして？',
  model: 'qwen3:8b',
  persona: 'ESFP',
  reason: 'meaning',
  ts: '2026-09-13T01:00:00.000Z',
  ...over,
})

test('FeedbackStore: 無ければ 0 件。追記すると増え、1 行 1 件で残る', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-fb-'))
  try {
    const store = new FeedbackStore(join(dir, 'sub', 'digest-feedback.jsonl'))
    await store.load()
    assert.equal(store.size, 0, '無ければ空（置き場ごと無くてもよい）')
    await store.append(entry())
    await store.append(entry({ reason: 'long', note: 'もっと短く' }))
    assert.equal(store.size, 2)
    const lines = (await readFile(store.path, 'utf-8')).trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0]!) as DigestFeedbackEntry
    assert.equal(first.key, 'S1@repo|2026-09-13T10:00:00+09:00')
    assert.equal(first.summary, 'PR #284 作成。マージして？', '言われた時点の一言を残す')
    assert.equal(first.model, 'qwen3:8b')
    assert.equal(first.note, undefined)
    assert.equal((JSON.parse(lines[1]!) as DigestFeedbackEntry).note, 'もっと短く')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FeedbackStore: すでにあるファイルの件数を読む。空行は数えない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-fb-'))
  try {
    const path = join(dir, 'digest-feedback.jsonl')
    await writeFile(path, JSON.stringify(entry()) + '\n\n' + JSON.stringify(entry()) + '\n')
    const store = new FeedbackStore(path)
    await store.load()
    await store.load()
    assert.equal(store.size, 2)
    await store.append(entry())
    assert.equal(store.size, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
