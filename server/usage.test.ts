import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CACHE_MS,
  claudeProjectsDir,
  codexSessionsDir,
  readClaudeUsage,
  readCodexUsage,
  recentRollouts,
  recentTranscripts,
  tailLines,
  TAIL_BYTES,
  UsageStore,
} from './usage.ts'

const tmp = () => mkdtemp(join(tmpdir(), 'sai-usage-'))

/** rate_limits を持つ token_count の行（手元の rollout と同じ形） */
const tokenCount = (percent: number, at: string, resetsAt = 1788956513) =>
  JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { model_context_window: 258400 },
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: percent, window_minutes: 300, resets_at: resetsAt },
        secondary: { used_percent: 20, window_minutes: 10080, resets_at: resetsAt + 500_000 },
        plan_type: 'plus',
      },
    },
  })

/** 使用量を持たない、ふつうの行。ファイルのかさ増しにも使う */
const chatter = (i: number) => JSON.stringify({ type: 'response_item', payload: { type: 'message', text: `x${i}` } })

async function writeRollout(dir: string, name: string, lines: string[], mtime?: Date): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, `${lines.join('\n')}\n`)
  if (mtime) await utimes(path, mtime, mtime)
  return path
}

test('codexSessionsDir: CODEX_HOME を尊重する（~ も展開する）。無ければ ~/.codex', () => {
  assert.equal(codexSessionsDir({}, '/home/me'), join('/home/me', '.codex', 'sessions'))
  assert.equal(codexSessionsDir({ CODEX_HOME: '/opt/codex' }, '/home/me'), join('/opt/codex', 'sessions'))
  assert.equal(codexSessionsDir({ CODEX_HOME: '~/alt' }, '/home/me'), join('/home/me', 'alt', 'sessions'))
  assert.equal(codexSessionsDir({ CODEX_HOME: '  ' }, '/home/me'), join('/home/me', '.codex', 'sessions'))
  assert.equal(claudeProjectsDir('/home/me'), join('/home/me', '.claude', 'projects'))
})

test('tailLines: 大きいファイルでも末尾しか読まず、切れた先頭行は捨てる', async () => {
  const dir = await tmp()
  // 1MB 超（手元の rollout は 12MB。全部読まないことを、読めた行の数で見る）
  const filler = Array.from({ length: 20_000 }, (_, i) => chatter(i))
  const path = await writeRollout(dir, 'big.jsonl', [...filler, tokenCount(59, '2026-09-09T08:39:28.618Z')])
  const lines = await tailLines(path)
  assert.ok(lines.length < filler.length, `末尾だけのはず: ${lines.length} 行`)
  assert.ok(lines.join('\n').length <= TAIL_BYTES)
  // 途中から始まった 1 行目を捨てているので、残りは全部 JSON として読める
  for (const line of lines) if (line.trim()) JSON.parse(line)
  assert.equal(JSON.parse(lines.at(-2)!).payload.type, 'token_count')

  // ファイルの頭から読めるときは 1 行目を捨てない
  const small = await writeRollout(dir, 'small.jsonl', [chatter(1), chatter(2)])
  assert.deepEqual(await tailLines(small), [chatter(1), chatter(2), ''])
  assert.deepEqual(await tailLines(join(dir, 'nope.jsonl')), [], '無いファイルは空')
})

test('recentRollouts: mtime の新しい順。開きっぱなしで古い日付のディレクトリにあるものも拾う', async () => {
  const root = await tmp()
  const old = new Date('2026-09-09T00:00:00Z')
  const fresh = new Date('2026-09-09T18:00:00Z')
  // 9/9 のディレクトリにあるが古い、9/4 のディレクトリにあるが新しい（手元で実際にこうなっていた）
  await writeRollout(join(root, '2026', '09', '09'), 'rollout-a.jsonl', [chatter(1)], old)
  const newest = await writeRollout(join(root, '2026', '09', '04'), 'rollout-b.jsonl', [chatter(1)], fresh)
  await writeRollout(join(root, '2026', '09', '04'), 'notes.txt', ['x'], fresh)
  // 古い Codex が sessions/ 直下に置いた .json（rate_limits を持たない）は拾わない
  await writeFile(join(root, 'rollout-2025-04-22-old.json'), '{}\n')

  const found = await recentRollouts(root)
  assert.equal(found[0], newest, 'mtime の新しい方が先')
  assert.equal(found.length, 2)
  assert.deepEqual(await recentRollouts(root, 1), [newest])
  assert.deepEqual(await recentRollouts(join(root, 'missing')), [], '置き場が無ければ空')
})

test('readCodexUsage: 一番新しい token_count を返す。同じファイルの中では最後の行', async () => {
  const root = await tmp()
  await writeRollout(
    join(root, '2026', '09', '09'),
    'rollout-a.jsonl',
    [tokenCount(10, '2026-09-09T01:00:00.000Z'), chatter(1), tokenCount(59, '2026-09-09T08:39:28.618Z')],
    new Date('2026-09-09T18:00:00Z'),
  )
  await writeRollout(join(root, '2026', '09', '08'), 'rollout-b.jsonl', [tokenCount(3, '2026-09-08T10:00:00.000Z')], new Date('2026-09-08T10:00:00Z'))

  const usage = await readCodexUsage(root)
  assert.equal(usage?.primary.used_percent, 59)
  assert.equal(usage?.primary.window_minutes, 300)
  assert.equal(usage?.secondary?.window_minutes, 10080)
  assert.equal(usage?.plan, 'plus')
  assert.equal(usage?.at, '2026-09-09T08:39:28.618Z')
})

test('readCodexUsage: rate_limits がどこにも無ければ null（Codex を使っていない人）', async () => {
  const root = await tmp()
  await writeRollout(join(root, '2026', '09', '09'), 'rollout-a.jsonl', [chatter(1), chatter(2)])
  assert.equal(await readCodexUsage(root), null)
  assert.equal(await readCodexUsage(join(root, 'missing')), null)
})

const rejected = (at: string, resetsAt: number) =>
  JSON.stringify({ timestamp: at, type: 'assistant', isApiErrorMessage: true, quotaLimits: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } })

async function writeTranscript(root: string, project: string, name: string, lines: string[], mtime?: Date): Promise<string> {
  const dir = join(root, project)
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, `${lines.join('\n')}\n`)
  if (mtime) await utimes(path, mtime, mtime)
  return path
}

test('recentTranscripts: since より古いファイルは見ない', async () => {
  const root = await tmp()
  const now = Date.now()
  const fresh = await writeTranscript(root, '-w-a', 'x.jsonl', [chatter(1)], new Date(now - 60_000))
  await writeTranscript(root, '-w-b', 'y.jsonl', [chatter(1)], new Date(now - 30 * 24 * 60 * 60 * 1000))
  await writeTranscript(root, '-w-b', 'notes.md', ['x'], new Date(now))
  assert.deepEqual(await recentTranscripts(root, now - 8 * 24 * 60 * 60 * 1000), [fresh])
  assert.deepEqual(await recentTranscripts(join(root, 'missing'), 0), [])
})

test('readClaudeUsage: 弾かれていて、まだ戻っていない記録だけを返す', async () => {
  const root = await tmp()
  const now = Date.parse('2026-09-09T10:00:00Z')
  const resets = Math.floor(now / 1000) + 42 * 60
  await writeTranscript(root, '-w-a', 'x.jsonl', [chatter(1), rejected('2026-09-09T09:30:00.000Z', resets)], new Date(now))
  const usage = await readClaudeUsage(root, now)
  assert.deepEqual(usage, { resets_at: resets, kind: 'five_hour', at: '2026-09-09T09:30:00.000Z' })
})

test('readClaudeUsage: 空の quotaLimits しか無い（普段）／もう戻った記録だけ、は null', async () => {
  const root = await tmp()
  const now = Date.parse('2026-09-09T10:00:00Z')
  await writeTranscript(root, '-w-a', 'x.jsonl', [JSON.stringify({ type: 'assistant', quotaLimits: {} })], new Date(now))
  await writeTranscript(root, '-w-b', 'y.jsonl', [rejected('2026-09-09T01:00:00.000Z', Math.floor(now / 1000) - 60)], new Date(now))
  assert.equal(await readClaudeUsage(root, now), null)
})

test('UsageStore: 読めないときは空の {}。CACHE_MS の間は読み直さない', async () => {
  const root = await tmp()
  const codex = join(root, 'codex')
  const claude = join(root, 'claude')
  let now = 1_000_000
  const store = new UsageStore(codex, claude, () => now)
  assert.deepEqual(await store.get(), {}, 'どちらも無ければ空。画面は黙って出さない')

  // キャッシュが効いている間は、あとから置いたファイルを拾わない
  await writeRollout(join(codex, '2026', '09', '09'), 'rollout-a.jsonl', [tokenCount(59, '2026-09-09T08:39:28.618Z')])
  assert.deepEqual(await store.get(), {})
  now += CACHE_MS
  assert.equal((await store.get()).codex?.primary.used_percent, 59)
})

test('UsageStore: 同時に呼ばれても読むのは 1 回（画面を開き直すたびに漁らない）', async () => {
  const root = await tmp()
  await writeRollout(join(root, '2026', '09', '09'), 'rollout-a.jsonl', [tokenCount(7, '2026-09-09T08:39:28.618Z')])
  const store = new UsageStore(root, join(root, 'none'))
  const [a, b] = await Promise.all([store.get(), store.get()])
  assert.equal(a, b, '同じ結果を返す（読み直していない）')
  assert.equal(a.codex?.primary.used_percent, 7)
})
