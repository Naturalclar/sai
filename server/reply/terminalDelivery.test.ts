// 端末に打ち込んだ・開いている Codex の queue に渡した返信が届いたかを確かめる（#329）。
// 前は 30 分の TTL で何も言わずに「処理中」が消え、受け取り手のいない queue に渡したことが分からなかった
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QUEUE_DELIVERY_WAIT_MS, QUEUE_FAILED_TTL_MS, TERMINAL_DELIVERY_WAIT_MS, TERMINAL_FAILED_TTL_MS, TERMINAL_REPLY_TTL_MS, TerminalReplies } from './terminal.ts'
import type { DeliveryQuery } from './terminal.ts'

const T0 = Date.parse('2026-09-11T05:04:03Z')

test('checkDelivery: 待ちを過ぎるまでは聞かない。始まっていれば以後は聞き直さない', async () => {
  let now = T0
  const r = new TerminalReplies(() => now)
  r.start('S@r', 'やって', 'queue')
  const asked: string[] = []
  const started = async (id: string, query: DeliveryQuery) => {
    asked.push(`${id} ${query.since} ${query.kind} ${query.text}`)
    return true
  }
  await r.checkDelivery(started)
  assert.deepEqual(asked, [], '待ちを過ぎるまでは聞かない')
  now += QUEUE_DELIVERY_WAIT_MS
  await r.checkDelivery(started)
  assert.deepEqual(asked, ['S@r 2026-09-11T05:04:03.000Z queue やって'], '経路と本文も渡す（queue は本文で届いたかを見る。#474）')
  await r.checkDelivery(started)
  assert.equal(asked.length, 1, '届いたと分かったら聞き直さない')
  assert.equal(r.running('S@r'), true)
  assert.equal(r.snapshot()['S@r']?.failed, undefined)
})

test('checkDelivery: queue に渡して届いていなければ、黙って消さずに failed にする', async () => {
  let now = T0
  const r = new TerminalReplies(() => now)
  r.start('X@r', 'SAIのmain用のアイコンも作って', 'queue')
  now += QUEUE_DELIVERY_WAIT_MS
  const missed = await r.checkDelivery(async () => false)
  const failed = r.snapshot()['X@r']?.failed
  assert.equal(failed?.code, undefined, 'プロセスが無いので終了コードは無い')
  assert.match(failed?.tail ?? '', /届いていません/)
  assert.match(failed?.tail ?? '', /開いている画面が無い/)
  assert.deepEqual(missed.map((m) => [m.id, m.kind]), [['X@r', 'queue']], '新しく失敗にしたものを返す（呼ぶ側が reply.log に残す）')
  assert.equal(r.running('X@r'), false, '失敗にしたら次の返信を止めない')
  assert.equal(r.snapshot()['X@r']?.text, 'SAIのmain用のアイコンも作って', '仮バブルの本文は残す')
  assert.deepEqual(await r.checkDelivery(async () => false), [], '同じ失敗を 2 回は返さない')
})

test('queue は 30 秒で確かめる（端末の 2 分を待たない）', async () => {
  let now = T0
  const r = new TerminalReplies(() => now)
  r.start('F@r', 'やって', 'queue')
  r.start('T@r', 'やって')
  now += QUEUE_DELIVERY_WAIT_MS
  const asked: string[] = []
  await r.checkDelivery(async (id) => {
    asked.push(id)
    return true
  })
  assert.deepEqual(asked, ['F@r'], '端末に打ち込んだ方はまだ聞かない')
  assert.ok(QUEUE_DELIVERY_WAIT_MS < TERMINAL_DELIVERY_WAIT_MS)
})

test('queue の失敗は 2 分では消さない（#474。消えると「送ったのに静かに終わった」だけが残る）', async () => {
  let now = T0
  const r = new TerminalReplies(() => now)
  r.start('Y@r', 'このリポジトリを表すアイコン画像を作成して欲しい', 'queue')
  now += QUEUE_DELIVERY_WAIT_MS
  await r.checkDelivery(async () => false)
  now += TERMINAL_FAILED_TTL_MS + 1
  r.settle(() => undefined)
  assert.ok(r.snapshot()['Y@r']?.failed, '端末の失敗なら消える時間を過ぎても、queue の失敗は残す')
  now += QUEUE_FAILED_TTL_MS
  r.settle(() => undefined)
  assert.equal(r.snapshot()['Y@r'], undefined, 'いつまでも残しはしない')
})

test('聞き先が理由を返したら、経路の文言の前に付ける', async () => {
  let now = T0
  const r = new TerminalReplies(() => now)
  r.start('Z@r', 'やって', 'queue')
  now += QUEUE_DELIVERY_WAIT_MS
  const [miss] = await r.checkDelivery(async () => 'このスレッドはいま共有の Codex app-server（pid 46927）が握っています。')
  assert.match(r.snapshot()['Z@r']?.failed?.tail ?? '', /^このスレッドはいま共有の Codex app-server（pid 46927）が握っています。 開いている Codex に渡しましたが/)
  assert.equal(miss?.reason, r.snapshot()['Z@r']?.failed?.tail, 'reply.log に残すのも画面と同じ文')
})

test('checkDelivery: 端末に打ち込んだ返信は端末の文言。遅れてターン完了が届けば失敗も消える', async () => {
  let now = T0
  const r = new TerminalReplies(() => now)
  r.start('T@r', '続けて')
  now += TERMINAL_DELIVERY_WAIT_MS
  await r.checkDelivery(async () => false)
  assert.match(r.snapshot()['T@r']?.failed?.tail ?? '', /入力欄に残っていないか/)
  r.settle(() => new Date(now).toISOString())
  assert.equal(r.snapshot()['T@r'], undefined)
})

test('checkDelivery: 聞いた先が投げたら届いた扱い。聞いている間に送り直したものは触らない', async () => {
  let now = T0
  const r = new TerminalReplies(() => now)
  r.start('A@r', 'a')
  r.start('B@r', 'b')
  now += TERMINAL_DELIVERY_WAIT_MS
  await r.checkDelivery(async (id) => {
    if (id === 'A@r') throw new Error('読めない')
    r.start('B@r', 'b2')
    return false
  })
  assert.equal(r.snapshot()['A@r']?.failed, undefined, '材料が無いのに届いていないと決めつけない')
  assert.equal(r.snapshot()['B@r']?.failed, undefined)
  assert.equal(r.snapshot()['B@r']?.text, 'b2')
})

test('届いたあとは今までどおり、ターン完了が来なくても TTL で黙って消す（長いターンを失敗と言わない）', async () => {
  let now = T0
  const r = new TerminalReplies(() => now)
  r.start('L@r', '長い作業', 'queue')
  now += TERMINAL_DELIVERY_WAIT_MS
  await r.checkDelivery(async () => true)
  now = T0 + TERMINAL_REPLY_TTL_MS + 1
  await r.checkDelivery(async () => false)
  r.settle(() => undefined)
  assert.equal(r.snapshot()['L@r'], undefined)
})
