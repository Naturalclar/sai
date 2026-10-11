import { test } from 'node:test'
import assert from 'node:assert/strict'
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
