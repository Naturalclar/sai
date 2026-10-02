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

test('TurnUsageLog: 行に載せる費用は、そのターンぶん（同じセッションの前の行との差。ファイルは積み上げのまま。#602）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-turnusage-'))
  try {
    const path = join(dir, 'turn-usage.jsonl')
    const old = new Date(Date.now() - (TURN_USAGE_KEEP_DAYS + 1) * 24 * 60 * 60_000).toISOString()
    await writeFile(
      path,
      [
        // 窓の外の行も「前の行」として辿る（辿らないと、窓の最初の行にそれまでの積み上げが丸ごと乗る）
        JSON.stringify({ ts: old, id: 'S@r', ...usage, cost_usd: 5 }),
        JSON.stringify({ ts: '2026-09-16T04:57:12.500Z', id: 'S@r', ...usage, cost_usd: 7.5 }),
        // 別のセッションの値は引かない
        JSON.stringify({ ts: '2026-09-16T05:00:00.500Z', id: 'T@r', ...usage, cost_usd: 100 }),
        JSON.stringify({ ts: '2026-09-16T05:30:01.000Z', id: 'S@r', ...usage, cost_usd: 8 }),
        // 費用の無い行を挟んでも、前の行の値を忘れない（忘れると次の行に積み上げが丸ごと乗る。#602 のレビュー）
        JSON.stringify({ ts: '2026-09-16T07:00:01.000Z', id: 'Z@r', ...usage, cost_usd: 40 }),
        JSON.stringify({ ts: '2026-09-16T07:30:01.000Z', id: 'Z@r', ...usage, cost_usd: 0 }),
        JSON.stringify({ ts: '2026-09-16T08:00:01.000Z', id: 'Z@r', ...usage, cost_usd: 45.5 }),
        // 数え直しで下がったら、その行の値をそのまま
        JSON.stringify({ ts: '2026-09-16T06:00:01.000Z', id: 'S@r', ...usage, cost_usd: 0.25 }),
        '',
      ].join('\n'),
      'utf-8',
    )
    // 境目を 0 にして、どの行も積み上げとして読む（窓の外の行は 90 日より前なので、既定の境目だと 1 ターンぶんの扱いになる日がある）
    const log = new TurnUsageLog(path, 0)
    await log.load()
    const row = (ts: string, session = 'S') => ({ ts, agent: 'claude', repo: 'r', branch: '', session, session_source: 'payload', cwd: '/w', event: 'Stop', text: 'ok' }) as FeedRow
    const attached = log.attach([row('2026-09-16T13:57:11+09:00'), row('2026-09-16T14:00:00+09:00', 'T'), row('2026-09-16T14:30:00+09:00'), row('2026-09-16T15:00:00+09:00')])
    assert.deepEqual(attached.map((r) => r.usage?.cost_usd), [2.5, 100, 0.5, 0.25])
    assert.deepEqual(log.attach([row('2026-09-16T16:00:00+09:00', 'Z'), row('2026-09-16T16:30:00+09:00', 'Z'), row('2026-09-16T17:00:00+09:00', 'Z')]).map((r) => r.usage?.cost_usd), [40, 0, 5.5])
    // 使用量の画面に渡す写し（#602）も同じ値（窓の外の行は入らない。書いた順）
    assert.deepEqual(log.turns().map((e) => [e.id, e.cost_usd]), [['S@r', 2.5], ['T@r', 100], ['S@r', 0.5], ['Z@r', 40], ['Z@r', 0], ['Z@r', 5.5], ['S@r', 0.25]])
    // 記録した分も、読み返した分の続きとして差にする
    const rowTs = new Date().toISOString()
    log.record('S@r', { ...usage, cost_usd: 1.25 })
    assert.equal(log.attach([row(rowTs)])[0]?.usage?.cost_usd, 1)
    // ファイルには CLI の値（積み上げ）のまま書く
    for (let i = 0; i < 50 && !(await readFile(path, 'utf-8')).includes('1.25'); i++) await new Promise((r) => setTimeout(r, 10))
    const lines = (await readFile(path, 'utf-8')).trim().split('\n')
    assert.equal((JSON.parse(lines[lines.length - 1]!) as TurnUsageEntry).cost_usd, 1.25)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TurnUsageLog: 積み上げになる前の行は、書かれた値のまま載せる（#602 のレビュー）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-turnusage-'))
  try {
    const path = join(dir, 'turn-usage.jsonl')
    const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
    await writeFile(path, [JSON.stringify({ ts: at(30), id: 'S@r', ...usage, cost_usd: 7.5 }), JSON.stringify({ ts: at(20), id: 'S@r', ...usage, cost_usd: 9 }), JSON.stringify({ ts: at(5), id: 'S@r', ...usage, cost_usd: 1.5 }), ''].join('\n'), 'utf-8')
    // 境目を 10 分前に置く: 前の 2 行は 1 ターンぶん、後ろの 1 行から積み上げ
    const log = new TurnUsageLog(path, Date.now() - 10 * 60_000)
    await log.load()
    const row = (m: number) => ({ ts: new Date(Date.now() - m * 60_000 - 1000).toISOString(), agent: 'claude', repo: 'r', branch: '', session: 'S', session_source: 'payload', cwd: '/w', event: 'Stop', text: 'ok' }) as FeedRow
    assert.deepEqual(log.attach([row(30), row(20), row(5)]).map((r) => r.usage?.cost_usd), [7.5, 9, 1.5])
    const rowTs = new Date().toISOString()
    log.record('S@r', { ...usage, cost_usd: 4 })
    assert.equal(log.attach([row(30), row(20), row(5), { ...row(0), ts: rowTs }])[3]?.usage?.cost_usd, 2.5)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
