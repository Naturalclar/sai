import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QUEUE_MAX, ReplyQueueStore } from './replyQueue.ts'

const URL = 'http://127.0.0.1:8787'

const withDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-queue-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('ReplyQueueStore: 古い順に預かり、起動できた先頭だけを外す（#305）', () => {
  const q = new ReplyQueueStore(null)
  const a = q.add('A@r', '一つ目', [], URL)!
  const b = q.add('A@r', '二つ目', ['/feed/attachments/x/y.png'], URL)!
  assert.match(a.queue_id, /^[0-9a-f]{16}$/)
  assert.notEqual(a.queue_id, b.queue_id)
  assert.equal(q.peek('A@r')?.text, '一つ目', '古い順')
  assert.equal(q.size('A@r'), 2)

  assert.equal(q.shift('A@r', b.queue_id), false, '先頭でないものは外さない（起動している間に並びが変わった）')
  assert.equal(q.shift('A@r', a.queue_id), true)
  assert.equal(q.peek('A@r')?.text, '二つ目')
  assert.deepEqual(q.peek('A@r')?.attachments, ['/feed/attachments/x/y.png'], '起動に要る添付は持っている')
  assert.equal(q.shift('A@r', b.queue_id), true)
  assert.equal(q.size('A@r'), 0)
  assert.deepEqual(q.snapshot(), {}, '空になったセッションは載せない')
})

test('ReplyQueueStore: 画面に出す形には添付の絶対パスと宛先を載せない', () => {
  const q = new ReplyQueueStore(null)
  const a = q.add('A@r', '見て', ['/feed/attachments/x/y.png'], URL, new Date('2026-09-10T07:00:00.000Z'))!
  assert.deepEqual(q.snapshot(), { 'A@r': { items: [{ queue_id: a.queue_id, text: '見て', since: '2026-09-10T07:00:00.000Z' }] } })
})

test('ReplyQueueStore: 取り消し・止める・再開。止めている間は回す候補に出ない', () => {
  const q = new ReplyQueueStore(null)
  const a = q.add('A@r', 'x', [], URL)!
  const b = q.add('A@r', 'y', [], URL)!
  q.add('B@r', 'z', [], URL)
  assert.deepEqual(q.ids().sort(), ['A@r', 'B@r'])

  q.pause('A@r', '前の返信が失敗したので止めています')
  assert.equal(q.paused('A@r'), '前の返信が失敗したので止めています')
  assert.deepEqual(q.ids(), ['B@r'], '止めているセッションは回さない')
  assert.equal(q.snapshot()['A@r']?.paused, '前の返信が失敗したので止めています', '理由は画面に出す')

  assert.equal(q.remove('A@r', 'ffffffffffffffff'), false, '知らない id')
  assert.equal(q.remove('A@r', b.queue_id), true, '先頭でなくても取り消せる')
  assert.equal(q.resume('A@r'), true)
  assert.equal(q.resume('A@r'), false, '止めていなければ false')
  assert.deepEqual(q.ids().sort(), ['A@r', 'B@r'])

  q.pause('A@r', 'また止めた')
  assert.equal(q.remove('A@r', a.queue_id), true)
  assert.equal(q.paused('A@r'), '', '空になったら止めていた理由ごと消える（次に預けたものまで止めない）')
  q.pause('C@r', '預かりが無い')
  assert.deepEqual(q.snapshot()['C@r'], undefined, '預かりの無いセッションは止めようがない')
})

test('ReplyQueueStore: removeWhere は条件に合う預かりだけをまとめて取り消す。空になったセッションは消える（#311）', () => {
  const q = new ReplyQueueStore(null)
  q.add('B@r', '人から', [], URL)
  q.add('B@r', 'A から', [], URL, new Date(), 'm1')
  q.add('C@r', 'A から', [], URL, new Date(), 'm2')
  q.add('C@r', 'Z から', [], URL, new Date(), 'm3')
  q.add('D@r', 'A から', [], URL, new Date(), 'm4')
  const fromA = new Set(['m1', 'm2', 'm4'])
  assert.equal(q.removeWhere((_id, item) => item.origin !== undefined && fromA.has(item.origin)), 3)
  assert.deepEqual(
    Object.fromEntries(Object.entries(q.snapshot()).map(([id, v]) => [id, v.items.map((i) => i.text)])),
    { 'B@r': ['人から'], 'C@r': ['Z から'] },
    '人の返信と別の送り元の分は残す。空になったセッションは消える',
  )
  assert.equal(q.removeWhere(() => false), 0)
})

test('ReplyQueueStore: 1 セッションに QUEUE_MAX 件まで。超えたら預からない', () => {
  const q = new ReplyQueueStore(null)
  for (let i = 0; i < QUEUE_MAX; i++) assert.ok(q.add('A@r', `${i}`, [], URL))
  assert.equal(q.add('A@r', 'あふれた', [], URL), null)
  assert.equal(q.size('A@r'), QUEUE_MAX)
  assert.ok(q.add('B@r', '別のセッションは別に数える', [], URL))
})

test('ReplyQueueStore: ファイルに書き、別のインスタンスが読み戻す（サーバを立て直しても消さない）', () =>
  withDir(async (dir) => {
    const path = join(dir, 'sub', 'reply-queue.json')
    const q = new ReplyQueueStore(path)
    const a = q.add('A@r', '再起動をまたぐ', ['/p.png'], URL, new Date(), 'm1')!
    q.pause('A@r', '止めた')
    const written = JSON.parse(await readFile(path, 'utf-8')) as Record<string, { items: { queue_id: string }[] }>
    assert.equal(written['A@r']?.items[0]?.queue_id, a.queue_id)

    const next = new ReplyQueueStore(path)
    assert.equal(next.peek('A@r')?.text, '再起動をまたぐ')
    assert.deepEqual(next.peek('A@r')?.attachments, ['/p.png'])
    assert.equal(next.peek('A@r')?.url, URL, '起動するときの宛先も持ち越す')
    assert.equal(next.peek('A@r')?.origin, 'm1', '別のセッションからのメッセージだった印も持ち越す（回したターンから先へ送らせない。#311）')
    assert.equal('origin' in (next.snapshot()['A@r']?.items[0] ?? {}), false, '画面には出さない')
    assert.equal(next.paused('A@r'), '止めた', '止めていたことも持ち越す（再起動で勝手に回し始めない）')
  }))

test('ReplyQueueStore: ファイルが無い・壊れている・形の合わない項目は無視して起動する', () =>
  withDir(async (dir) => {
    assert.deepEqual(new ReplyQueueStore(join(dir, 'none.json')).snapshot(), {})
    const broken = join(dir, 'broken.json')
    await writeFile(broken, '{ broken')
    assert.deepEqual(new ReplyQueueStore(broken).snapshot(), {})

    const junk = join(dir, 'junk.json')
    await writeFile(
      junk,
      JSON.stringify({
        'A@r': { items: [{ queue_id: 'aaaaaaaaaaaaaaaa', text: '残る', since: '2026-09-10T07:00:00.000Z' }, { queue_id: 'b', text: '' }, 'x'] },
        'B@r': { items: 'not an array' },
        'C@r': null,
      }),
    )
    const q = new ReplyQueueStore(junk)
    assert.deepEqual(Object.keys(q.snapshot()), ['A@r'])
    assert.deepEqual(q.peek('A@r'), { queue_id: 'aaaaaaaaaaaaaaaa', text: '残る', since: '2026-09-10T07:00:00.000Z', attachments: [], url: '' })
  }))

test('ReplyQueueStore: key() は預けた・外した・止めた・再開した、で変わる（rev に混ぜる）', () => {
  const q = new ReplyQueueStore(null)
  const keys = [q.key()]
  const a = q.add('A@r', 'x', [], URL)!
  keys.push(q.key())
  q.pause('A@r', '止めた')
  keys.push(q.key())
  q.resume('A@r')
  assert.equal(q.key(), keys[1], '再開したら預けただけの状態と同じ')
  q.shift('A@r', a.queue_id)
  assert.equal(q.key(), keys[0])
  assert.equal(new Set(keys).size, 3)
})
