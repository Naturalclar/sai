import { test } from 'node:test'
import assert from 'node:assert/strict'
import { screenWait, softWait } from './softWait.ts'

const after = <T,>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))

test('softWait: 締切までに終われば結果、終わらなければ前回の結果。走査は捨てずに続く', async () => {
  assert.equal(await softWait(after(10, 'fresh'), () => 'stale', 200), 'fresh')

  let finished = ''
  const slow = after(120, 'late').then((v) => (finished = v))
  const t = Date.now()
  assert.equal(await softWait(slow, () => 'stale', 30), 'stale', '締切で前回の結果')
  assert.ok(Date.now() - t < 100, '締切で返る（走査を待たない）')
  assert.equal(finished, '', 'まだ走っている')
  await slow
  assert.equal(finished, 'late', '裏で終わる（次の要求のキャッシュになる）')
})

test('softWait: 締切の前の失敗はそのまま投げ、締切のあとの失敗は捨てる（unhandled にしない）', async () => {
  await assert.rejects(softWait(Promise.reject(new Error('boom')), () => 'stale', 100), /boom/)

  const lateFail = new Promise<string>((_, reject) => setTimeout(() => reject(new Error('late')), 60))
  assert.equal(await softWait(lateFail, () => 'stale', 20), 'stale')
  await new Promise((r) => setTimeout(r, 80)) // 失敗が起きるまで待つ。unhandled なら node:test が落とす
})

test('screenWait: 前回の結果があれば待たずに返し、無ければ締切まで待つ（#592）', async () => {
  let finished = ''
  const slow = after(40, 'late').then((v) => (finished = v))
  assert.equal(await screenWait(slow, () => 'stale', true), 'stale', '終わっていない走査を待たない')
  assert.equal(finished, '', 'まだ走っている')
  await slow
  assert.equal(finished, 'late', '裏で終わる')
  // すでに終わっている走査（TTL の中で覚えた結果）はその結果
  assert.equal(await screenWait(Promise.resolve('fresh'), () => 'stale', true), 'fresh')
  // 1 度も終わっていなければ、今までどおり締切まで待つ
  assert.equal(await screenWait(after(20, 'first'), () => 'empty', false), 'first')
})
