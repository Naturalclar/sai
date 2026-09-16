import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TurnUsageLog, type TurnUsageEntry } from './turnUsage.ts'

const usage = { model: 'claude-opus-5', input_tokens: 10, output_tokens: 39, cache_read_input_tokens: 17582, cache_creation_input_tokens: 8431, cost_usd: 0.019, duration_ms: 1297, num_turns: 1, denials: 0, is_error: false }

test('TurnUsageLog: 1 ターン 1 行で追記する（id と時刻を足す）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-turnusage-'))
  try {
    const log = new TurnUsageLog(join(dir, 'sub', 'turn-usage.jsonl'))
    log.record('A@r', usage)
    log.record('B@r', { ...usage, denials: 2 })
    // 追記は投げっぱなし（返信を待たせない）ので、書き終わるのを待ってから読む
    for (let i = 0; i < 50 && !(await readFile(join(dir, 'sub', 'turn-usage.jsonl'), 'utf-8').catch(() => '')).includes('B@r'); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const lines = (await readFile(join(dir, 'sub', 'turn-usage.jsonl'), 'utf-8')).trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0]!) as TurnUsageEntry
    assert.equal(first.id, 'A@r')
    assert.equal(first.output_tokens, 39)
    assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal((JSON.parse(lines[1]!) as TurnUsageEntry).denials, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TurnUsageLog: 書けない場所でも投げない（返信を止めない）', async () => {
  const log = new TurnUsageLog('/dev/null/無理なパス/turn-usage.jsonl')
  log.record('A@r', usage)
  await new Promise((r) => setTimeout(r, 50))
})
