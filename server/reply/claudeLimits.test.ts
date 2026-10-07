import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseStatusLineUsage } from '../../shared/usage.ts'
import { CLAUDE_REPLY_LIMITS_FILE, ClaudeLimitsFile, isReplyLimitsFile, LIMITS_WRITE_MS, replyLimitsFile } from './claudeLimits.ts'
import { isClaudeUsageFile } from '../local/usage.ts'

const event = (five: number, week: number, resets: number) =>
  JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: five, resetsAt: resets }, seven_day: { utilization: week, resetsAt: resets + 86400 } } }, session_id: 'S' })

test('返信の出力の使用率を usage-claude.json と同じ形で置く。値に依らず 10 秒は書き直さない（#694）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-limits-'))
  try {
    let now = Date.parse('2026-10-06T05:00:00Z')
    const resets = Math.floor(now / 1000) + 3600
    const path = join(dir, 'feed', CLAUDE_REPLY_LIMITS_FILE)
    const limits = new ClaudeLimitsFile(path, () => now)
    const read = async () => JSON.parse(await readFile(path, 'utf-8')) as { ts: string; rate_limits: { five_hour: { used_percentage: number } } }

    limits.observe('{"type":"assistant"}\n')
    assert.deepEqual(await readdir(dir), [], '知らせが無ければ何も作らない')

    limits.observe(`{"type":"assistant"}\n${event(0.13, 0.6, resets)}\n`)
    const first = await read()
    assert.equal(first.ts, '2026-10-06T05:00:00.000Z')
    // 読む側は usage-claude.json と同じ関数で読める
    const usage = parseStatusLineUsage(first, now)
    assert.deepEqual([usage?.primary?.used_percent, usage?.secondary?.used_percent, usage?.at], [13, 60, first.ts])

    now += LIMITS_WRITE_MS - 1
    limits.observe(`${event(0.14, 0.6, resets)}\n`)
    assert.deepEqual(await read(), first, '値が変わっていても、間隔の中では書かない（応答のたびに書かない）')
    now += 1
    limits.observe(`${event(0.14, 0.6, resets)}\n`)
    assert.deepEqual([(await read()).ts, (await read()).rate_limits.five_hour.used_percentage], [new Date(now).toISOString(), 14])
    now += LIMITS_WRITE_MS
    limits.observe(`${event(0.14, 0.6, resets)}\n`)
    assert.equal((await read()).ts, new Date(now).toISOString(), '同じ値でも、届いた時刻は進める')
    assert.deepEqual(await readdir(join(dir, 'feed')), [CLAUDE_REPLY_LIMITS_FILE], 'tmp を残さない')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('書けなかったときは覚えず、次の知らせでまた試す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-limits-retry-'))
  try {
    const now = Date.parse('2026-10-06T05:00:00Z')
    // 置き場の親がファイルなので書けない
    await writeFile(join(dir, 'blocker'), '')
    const limits = new ClaudeLimitsFile(join(dir, 'blocker', 'x.json'), () => now)
    assert.doesNotThrow(() => limits.observe(`${event(0.1, 0.2, 1791269400)}\n`))
    const ok = new ClaudeLimitsFile(join(dir, 'x.json'), () => now)
    Object.assign(limits, { path: ok.path })
    limits.observe(`${event(0.1, 0.2, 1791269400)}\n`)
    assert.deepEqual(await readdir(dir), ['blocker', 'x.json'], '同じ時刻でも、前が書けていなければ書く')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('置くファイルの名前: AGENT_FEED_HOST を設定したときだけマシンごとに分け、読む側は両方拾う', () => {
  assert.equal(replyLimitsFile({}), 'usage-claude-replies.json')
  assert.equal(replyLimitsFile({ AGENT_FEED_HOST: ' mbp.local ' }), 'usage-claude-replies.mbp.json')
  assert.equal(replyLimitsFile({ AGENT_FEED_HOST: 'my mac/1' }), 'usage-claude-replies.my-mac-1.json')
  for (const name of ['usage-claude-replies.json', 'usage-claude-replies.mbp.json']) {
    assert.equal(isReplyLimitsFile(name), true, name)
    assert.equal(isClaudeUsageFile(name), false, `${name} は statusline.py のファイルとして読まれない`)
  }
  assert.equal(isReplyLimitsFile('usage-claude.json'), false)
  assert.equal(isReplyLimitsFile('usage-claude-replies.json.123.tmp'), false)
})
