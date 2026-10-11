import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, statSync } from 'node:fs'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recentDates } from './aggregate.ts'
import { FeedStore, feedFiles, parseRows } from './store.ts'

/** 今日と昨日（置き場の日付ファイル名と同じ切り方） */
const [today, yesterday] = recentDates(2) as [string, string]

function row(ts: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, v: 7, event: 'Stop', agent: 'claude', ...extra }) + '\n'
}

test('feedFiles: 日付ファイルと <host> 付きを拾い、それ以外は落とす', () => {
  const names = [
    `${today}.jsonl`,
    `${today}.mini.jsonl`,
    `${today}.air.jsonl`,
    `${yesterday}.jsonl`,
    'digest.jsonl', // 派生データ。日付ファイルではない
    `${today}.jsonl.tmp`, // 同期の途中
    'notes.txt',
    '2026-13-99.jsonl', // 日付に見えない
  ]
  // 日付は新しい順に渡っても、返りはその順（呼ぶ側が recentDates の順で読む）
  assert.deepEqual(feedFiles(names, [today, yesterday]), [
    `${today}.jsonl`, // host 無しが先
    `${today}.air.jsonl`, // 以降は host 名の順
    `${today}.mini.jsonl`,
    `${yesterday}.jsonl`,
  ])
})

test('feedFiles: 窓の外の日付は読まない', () => {
  assert.deepEqual(feedFiles([`${today}.jsonl`, `${yesterday}.mini.jsonl`], [today]), [`${today}.jsonl`])
})

test('feedFiles: readdir の順に依らず、同じ並びを返す', () => {
  const names = [`${today}.mini.jsonl`, `${today}.jsonl`, `${today}.air.jsonl`]
  const expected = [`${today}.jsonl`, `${today}.air.jsonl`, `${today}.mini.jsonl`]
  assert.deepEqual(feedFiles(names, [today]), expected)
  assert.deepEqual(feedFiles([...names].reverse(), [today]), expected)
})

test('parseRows: 壊れた行と書きかけの行は落とす', () => {
  // 同期の途中で末尾が切れた行（改行で終わっていない）も、JSON として壊れているので落ちる
  const text = `${row(`${today}T09:00:00+09:00`)}こわれた\n{"ts":"${today}`
  assert.deepEqual(
    parseRows(text).map((r) => r.ts),
    [`${today}T09:00:00+09:00`],
  )
})

test('FeedStore: 同じ日の別マシンのファイルも読み、ts の順に混ぜる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-store-'))
  try {
    await writeFile(join(dir, `${today}.jsonl`), row(`${today}T09:00:00+09:00`, { text: 'mac 1' }) + row(`${today}T11:00:00+09:00`, { text: 'mac 2' }))
    await writeFile(join(dir, `${today}.mini.jsonl`), row(`${today}T10:00:00+09:00`, { text: 'mini 1', host: 'mini' }))
    const store = new FeedStore(dir)
    assert.deepEqual(
      (await store.rows(1)).map((r) => r.text),
      ['mac 1', 'mini 1', 'mac 2'],
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FeedStore: 別マシンのファイルだけが増えても rev が変わる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-store-'))
  try {
    await writeFile(join(dir, `${today}.jsonl`), row(`${today}T09:00:00+09:00`))
    const store = new FeedStore(dir)
    const before = await store.sessions(1)

    // 新しいマシンのファイルが同期で降ってきた
    await writeFile(join(dir, `${today}.mini.jsonl`), row(`${today}T10:00:00+09:00`, { host: 'mini' }))
    const added = await store.sessions(1)
    assert.notEqual(added.rev, before.rev, 'ファイルが増えたら rev が変わる')

    // そのファイルにだけ追記された
    await appendFile(join(dir, `${today}.mini.jsonl`), row(`${today}T10:30:00+09:00`, { host: 'mini' }))
    const appended = await store.sessions(1)
    assert.notEqual(appended.rev, added.rev, '別マシンのファイルへの追記でも rev が変わる')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FeedStore: 置き場がまだ無くても落ちない', async () => {
  const store = new FeedStore(join(tmpdir(), 'sai-store-does-not-exist'))
  assert.deepEqual(await store.rows(2), [])
  assert.deepEqual(await store.signature(2), [])
})

test('FeedStore: 同時に来た同じ読みは 1 回にまとめ、終わったら読み直す（#765）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-store-'))
  try {
    await writeFile(join(dir, `${today}.jsonl`), row(`${today}T09:00:00+09:00`, { session: 'a' }))
    const store = new FeedStore(dir)

    // 返る前に重ねた呼び出しは同じ Promise（stat も集計も 1 回）
    const first = store.sessions(1)
    const second = store.sessions(1)
    assert.equal(second, first, '同時の sessions(1) が別々に走った')
    const rowsA = store.rows(1)
    const rowsB = store.rows(1)
    assert.equal(rowsB, rowsA, '同時の rows(1) が別々に走った')
    assert.notEqual(store.sessions(2) as unknown, first, 'days が違えば別')
    assert.equal((await first).sessions.length, 1)
    assert.equal((await rowsA).length, 1)

    // 終わったあとは忘れる。記録が伸びていれば読み直す
    await appendFile(join(dir, `${today}.jsonl`), row(`${today}T10:00:00+09:00`, { session: 'b' }))
    const later = store.sessions(1)
    assert.notEqual(later, first, '終わった読みを使い回した')
    assert.equal((await later).sessions.length, 2)
    assert.equal((await store.rows(1)).length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FeedStore: 読みかけの間に記録が伸びても、古い行の集計を新しい rev で覚えない（#765 のレビュー）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-store-'))
  try {
    // 今日 + 古い日付 19 つ。読みは今日から順に 1 ファイルずつ（stat → 読む）進む。まだ何も覚えていない store で始める
    // （覚えていると古い日付は stat だけで済み、署名を取る側より先に読み終わってしまう）
    const days = 20
    const dates = recentDates(days)
    for (const d of dates) await writeFile(join(dir, `${d}.jsonl`), row(`${d}T09:00:00+09:00`, { session: `s-${d}` }))
    const store = new FeedStore(dir)

    // 別の要求の rows() が今日のぶんを読み終えて古い日付を読んでいる最中に追記が入り、そのあとに sessions() が来る
    const todayPath = join(dir, `${today}.jsonl`)
    const grown = statSync(todayPath).size
    const reading = store.rows(days)
    const files = (store as unknown as { files: Map<string, { size: number }> }).files
    for (let i = 0; i < 10_000 && (files.get(todayPath)?.size ?? 0) < grown; i++) await new Promise((r) => setImmediate(r))
    assert.equal(files.get(todayPath)?.size, grown, '今日のぶんを読み終える前に抜けた')
    appendFileSync(todayPath, row(`${today}T10:00:00+09:00`, { session: 'late' }))
    const joined = store.sessions(days)
    await Promise.all([reading, joined])

    // 落ち着いたあとの sessions() は追記を含む（前は、新しい署名の鍵に古い集計を覚えて、ファイルが次に変わるまで出なかった）
    const after = await store.sessions(days)
    assert.ok(after.sessions.some((x) => x.id === 'late'), '古い集計が新しい署名で残っている')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FeedStore: 署名が同じ間は、繋ぎ直した行の配列を使い回す（#765 のレビュー。1 リクエストの中の続けざまの rows()）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-store-'))
  try {
    await writeFile(join(dir, `${today}.jsonl`), row(`${today}T09:00:00+09:00`, { session: 'a' }))
    const store = new FeedStore(dir)
    const first = await store.rows(1)
    assert.equal(await store.rows(1), first, '変わっていないのに繋ぎ直した')
    await appendFile(join(dir, `${today}.jsonl`), row(`${today}T10:00:00+09:00`, { session: 'b' }))
    const second = await store.rows(1)
    assert.notEqual(second, first)
    assert.equal(second.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
