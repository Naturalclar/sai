import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TURN_USAGE_KEEP_DAYS, TurnUsageLog, type TurnUsageEntry } from './turnUsage.ts'
import type { FeedRow } from '../../shared/types.ts'

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

test('TurnUsageLog: 起動時に読み返し、行に載せる（記録した分もそのまま載る。#411）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-turnusage-'))
  try {
    const path = join(dir, 'turn-usage.jsonl')
    const old = new Date(Date.now() - (TURN_USAGE_KEEP_DAYS + 1) * 24 * 60 * 60_000).toISOString()
    await writeFile(
      path,
      [
        JSON.stringify({ ts: '2026-09-16T04:57:12.500Z', id: 'S@r', ...usage, output_tokens: 94 }),
        '{壊れた行',
        JSON.stringify({ ts: old, id: 'S@r', ...usage }),
        '',
      ].join('\n'),
      'utf-8',
    )
    const log = new TurnUsageLog(path)
    await log.load()
    const before = log.rev()
    const rows = [
      { ts: '2026-09-16T13:57:11+09:00', agent: 'claude', repo: 'r', branch: '', session: 'S', session_source: 'payload', cwd: '/w', event: 'Stop', text: 'ok' },
      { ts: '2026-09-16T14:30:00+09:00', agent: 'claude', repo: 'r', branch: '', session: 'S', session_source: 'payload', cwd: '/w', event: 'Stop', text: 'まだ' },
    ] as FeedRow[]
    // 窓の外（90 日より前）と壊れた行は読み返さない
    assert.equal(log.size, 1)
    const attached = log.attach(rows)
    assert.equal(attached[0]?.usage?.output_tokens, 94)
    // 古い行（窓の外）は読み返さないので、2 つめには何も付かない
    assert.equal(attached[1]?.usage, undefined)
    // 記録すると rev が変わる（行より 1〜2 秒遅れて届くので、変わらないと画面が拾わない）。
    // 行の ts は record() の**前**に採る: usageByRow() は使用量より後の行を見ないので、record() のあとに
    // new Date() を取ると、別のミリ秒に入った瞬間に当たらなくなる（CI で 1 回だけ落ちた。#424）。
    // 実物と同じ向き（Stop フックの行が先、使用量が後）はこのまま
    const rowTs = new Date().toISOString()
    log.record('S@r', { ...usage, output_tokens: 7 })
    assert.notEqual(log.rev(), before)
    const now = log.attach([{ ...rows[1]!, ts: rowTs }])
    assert.equal(now[0]?.usage?.output_tokens, 7)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TurnUsageLog: ファイルが無ければ空のまま（行はそのまま返す）', async () => {
  const log = new TurnUsageLog(join(tmpdir(), 'sai-turnusage-無いファイル', 'turn-usage.jsonl'))
  await log.load()
  const rows = [{ ts: '2026-09-16T13:57:11+09:00', agent: 'claude', repo: 'r', branch: '', session: 'S', session_source: 'payload', cwd: '/w', event: 'Stop', text: 'ok' }] as FeedRow[]
  assert.equal(log.attach(rows), rows)
})
