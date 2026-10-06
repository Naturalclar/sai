import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseStatusLineUsage } from '../../shared/usage.ts'
import { CLAUDE_REPLY_LIMITS_FILE, ClaudeLimitsFile, LIMITS_REFRESH_MS } from './claudeLimits.ts'
import { isClaudeUsageFile } from '../local/usage.ts'

const event = (five: number, week: number, resets: number) =>
  JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: five, resetsAt: resets }, seven_day: { utilization: week, resetsAt: resets + 86400 } } }, session_id: 'S' })

test('返信の出力の使用率を usage-claude.json と同じ形で置く。値が同じなら 1 分は書き直さない（#694）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-limits-'))
  try {
    let now = Date.parse('2026-10-06T05:00:00Z')
    const resets = Math.floor(now / 1000) + 3600
    const path = join(dir, 'feed', CLAUDE_REPLY_LIMITS_FILE)
    const limits = new ClaudeLimitsFile(path, () => now)
    const read = async () => JSON.parse(await readFile(path, 'utf-8')) as { ts: string; rate_limits: unknown }

    limits.observe('{"type":"assistant"}\n')
    assert.deepEqual(await readdir(dir), [], '知らせが無ければ何も作らない')

    limits.observe(`{"type":"assistant"}\n${event(0.13, 0.6, resets)}\n`)
    const first = await read()
    assert.equal(first.ts, '2026-10-06T05:00:00.000Z')
    // 読む側は usage-claude.json と同じ関数で読める
    const usage = parseStatusLineUsage(first, now)
    assert.deepEqual([usage?.primary?.used_percent, usage?.secondary?.used_percent, usage?.at], [13, 60, first.ts])

    now += 10_000
    limits.observe(`${event(0.13, 0.6, resets)}\n`)
    assert.equal((await read()).ts, first.ts, '同じ値なら書き直さない（応答のたびに書かない）')
    limits.observe(`${event(0.14, 0.6, resets)}\n`)
    assert.equal((await read()).ts, '2026-10-06T05:00:10.000Z', '値が変われば書く')

    now += LIMITS_REFRESH_MS
    limits.observe(`${event(0.14, 0.6, resets)}\n`)
    assert.equal((await read()).ts, new Date(now).toISOString(), '同じ値でも 1 分たてば届いた時刻を進める')
    assert.deepEqual(await readdir(join(dir, 'feed')), [CLAUDE_REPLY_LIMITS_FILE], 'tmp を残さない')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('置き場が書けなくても投げない・ステータスラインのファイルとは名前を分ける', () => {
  assert.doesNotThrow(() => new ClaudeLimitsFile('/dev/null/nowhere/x.json').observe(`${event(0.1, 0.2, 1791269400)}\n`))
  assert.equal(isClaudeUsageFile(CLAUDE_REPLY_LIMITS_FILE), false, 'statusline.py のファイル（マシンごと）として読まれない')
})
