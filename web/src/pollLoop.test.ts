import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { pollLoop } from './pollLoop.ts'

/** run の 1 回ぶん。手で返す */
function deferred() {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 返したあとの `finally` まで進める（setImmediate は偽物にしていない） */
const flush = () => new Promise<void>((r) => setImmediate(r))

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => mock.timers.reset())

test('pollLoop: 前の run が返るまで、間隔が過ぎても次を投げない（#765）', async () => {
  const runs: ReturnType<typeof deferred>[] = []
  const loop = pollLoop(
    () => {
      const d = deferred()
      runs.push(d)
      return d.promise
    },
    () => 3000,
  )
  assert.equal(runs.length, 1)
  mock.timers.tick(30_000)
  assert.equal(runs.length, 1, '返っていないのに次を投げた')
  runs[0]!.resolve()
  await flush()
  assert.equal(runs.length, 1, '返った直後に投げた（間隔を待たない）')
  mock.timers.tick(2999)
  assert.equal(runs.length, 1)
  mock.timers.tick(1)
  assert.equal(runs.length, 2, '返ってから 3 秒で次')
  loop.stop()
})

test('pollLoop: 走っている間の kick は、終わった直後に 1 回だけ回す', async () => {
  const runs: ReturnType<typeof deferred>[] = []
  const loop = pollLoop(
    () => {
      const d = deferred()
      runs.push(d)
      return d.promise
    },
    () => 3000,
  )
  loop.kick()
  loop.kick()
  assert.equal(runs.length, 1)
  runs[0]!.resolve()
  await flush()
  assert.equal(runs.length, 2, 'kick のぶんを終わった直後に回す')
  runs[1]!.resolve()
  await flush()
  assert.equal(runs.length, 2, '2 回の kick を 2 回にしない')
  loop.stop()
})

test('pollLoop: 止まっているときの kick は待たずに回し、張ってあった次は捨てる', async () => {
  let calls = 0
  const loop = pollLoop(
    async () => {
      calls++
    },
    () => 3000,
  )
  await flush()
  assert.equal(calls, 1)
  mock.timers.tick(2000)
  loop.kick()
  await flush()
  assert.equal(calls, 2)
  mock.timers.tick(1000)
  assert.equal(calls, 2, '古いタイマーが残っていた')
  mock.timers.tick(2000)
  assert.equal(calls, 3, 'kick から 3 秒で次')
  loop.stop()
})

test('pollLoop: 間隔が 0 なら張らない。rearm で間隔を取り直す', async () => {
  let calls = 0
  let ms = 0
  const loop = pollLoop(
    async () => {
      calls++
    },
    () => ms,
  )
  await flush()
  assert.equal(calls, 1)
  mock.timers.tick(100_000)
  assert.equal(calls, 1, '間隔 0 なのに回った')
  ms = 20_000
  loop.rearm()
  mock.timers.tick(19_999)
  assert.equal(calls, 1)
  mock.timers.tick(1)
  assert.equal(calls, 2)
  await flush()
  ms = 3000
  loop.rearm()
  mock.timers.tick(3000)
  assert.equal(calls, 3, '取り直した間隔で次')
  loop.stop()
})

test('pollLoop: 走っている間の rearm は何もせず、終わったときの間隔で張る', async () => {
  const runs: ReturnType<typeof deferred>[] = []
  let ms = 3000
  const loop = pollLoop(
    () => {
      const d = deferred()
      runs.push(d)
      return d.promise
    },
    () => ms,
  )
  ms = 20_000
  loop.rearm()
  runs[0]!.resolve()
  await flush()
  mock.timers.tick(3000)
  assert.equal(runs.length, 1, '古い 3 秒で張った')
  mock.timers.tick(17_000)
  assert.equal(runs.length, 2)
  loop.stop()
})

test('pollLoop: stop のあとは張らない。走っていたものが返っても張らない', async () => {
  const runs: ReturnType<typeof deferred>[] = []
  const loop = pollLoop(
    () => {
      const d = deferred()
      runs.push(d)
      return d.promise
    },
    () => 3000,
  )
  loop.stop()
  runs[0]!.resolve()
  await flush()
  mock.timers.tick(30_000)
  assert.equal(runs.length, 1)
  loop.kick()
  assert.equal(runs.length, 1, 'stop のあとの kick で回った')
})

test('pollLoop: run が投げても次を張る', async () => {
  let calls = 0
  const loop = pollLoop(
    async () => {
      calls++
      throw new Error('fetch failed')
    },
    () => 3000,
  )
  await flush()
  assert.equal(calls, 1)
  mock.timers.tick(3000)
  await flush()
  assert.equal(calls, 2)
  loop.stop()
})
