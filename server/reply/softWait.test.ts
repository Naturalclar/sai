import { test } from 'node:test'
import assert from 'node:assert/strict'
import { softWait } from './softWait.ts'

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
