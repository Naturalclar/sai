// 端末に打ち込んだ・開いている Codex の queue に渡した返信が届いたかを確かめる（#329）。
// 前は 30 分の TTL で何も言わずに「処理中」が消え、受け取り手のいない queue に渡したことが分からなかった
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TERMINAL_DELIVERY_WAIT_MS, TERMINAL_FAILED_TTL_MS, TERMINAL_REPLY_TTL_MS, TerminalReplies } from './terminal.ts'

const T0 = Date.parse('2026-09-11T05:04:03Z')

test('checkDelivery: 待ちを過ぎるまでは聞かない。始まっていれば以後は聞き直さない', async () => {
  let now = T0
  const r = new TerminalReplies(() => now)
  r.start('S@r', 'やって', 'queue')
  const asked: string[] = []
  const started = async (id: string, since: string) => {
    asked.push(`${id} ${since}`)
    return true
  }
  await r.checkDelivery(started)
  assert.deepEqual(asked, [], '2 分たつまでは聞かない')
  now += TERMINAL_DELIVERY_WAIT_MS
  await r.checkDelivery(started)
  assert.deepEqual(asked, ['S@r 2026-09-11T05:04:03.000Z'])
  await r.checkDelivery(started)
  assert.equal(asked.length, 1, '届いたと分かったら聞き直さない')
  assert.equal(r.running('S@r'), true)
  assert.equal(r.snapshot()['S@r']?.failed, undefined)
})

test('checkDelivery: queue に渡してターンが始まっていなければ、黙って消さずに failed にする', async () => {
  let now = T0
  const r = new TerminalReplies(() => now)
  r.start('X@r', 'SAIのmain用のアイコンも作って', 'queue')
  now += TERMINAL_DELIVERY_WAIT_MS
  await r.checkDelivery(async () => false)
  const failed = r.snapshot()['X@r']?.failed
  assert.equal(failed?.code, undefined, 'プロセスが無いので終了コードは無い')
  assert.match(failed?.tail ?? '', /受け取られていません/)
  assert.match(failed?.tail ?? '', /キューに残って/)
  assert.equal(r.running('X@r'), false, '失敗にしたら次の返信を止めない')
  assert.equal(r.snapshot()['X@r']?.text, 'SAIのmain用のアイコンも作って', '仮バブルの本文は残す')
  r.settle(() => undefined)
  assert.ok(r.snapshot()['X@r'], '失敗は少しの間見せる')
  now += TERMINAL_FAILED_TTL_MS + 1
  r.settle(() => undefined)
  assert.equal(r.snapshot()['X@r'], undefined, 'そのあと消す')
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
