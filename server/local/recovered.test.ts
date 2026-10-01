// 補う候補の transcript を、ポーリングのたびに読まない（#592 / #627 のレビュー）。偽の ProgressReader で読んだ回数を数える
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ClaudeTurn } from '../../shared/claudeTurns.ts'
import type { FeedRow } from '../../shared/types.ts'
import type { ProgressReader } from './progress.ts'
import { RecoveredTurns } from './recovered.ts'

const T0 = Date.parse('2026-10-01T02:00:00Z')
const input: FeedRow = { ts: '2026-10-01T11:00:00+09:00', agent: 'claude', repo: 'repo', session: 'S1', session_source: 'payload', cwd: '/w', event: 'UserPromptSubmit', user_text: 'PR を出して', text: '' } as FeedRow
const turn = (over: Partial<ClaudeTurn> = {}): ClaudeTurn => ({ startedAt: T0, input: 'PR を出して', text: '途中', closed: false, endedAt: new Date(T0 + 60_000).toISOString(), over: false, ...over })

function setup(first: ClaudeTurn) {
  const state = { now: T0 + 10 * 60_000, sig: 'a', turns: [first], tails: 0, fulls: 0, stats: 0 }
  const progress = {
    claudeSig: async () => {
      state.stats++
      return state.sig
    },
    claudeTurns: async (_s: string, _c: string, full: boolean) => {
      if (full) state.fulls++
      else state.tails++
      return { sig: state.sig, turns: state.turns }
    },
  } as unknown as ProgressReader
  const recovered = new RecoveredTurns(progress, { isRemote: () => false, busy: () => false, now: () => state.now })
  return { state, recovered }
}

test('決まらない候補（閉じていない最後のターン）は、transcript が変わるまで読み直さない', async () => {
  const { state, recovered } = setup(turn())
  for (let i = 0; i < 5; i++) assert.equal((await recovered.apply([input])).key, '')
  assert.equal(state.tails, 1, '同じポーリングの間に何度呼ばれても 1 回')
  state.now += 20_000
  await recovered.apply([input])
  assert.deepEqual([state.tails, state.stats], [1, 1], '間隔が明けても、変わっていなければ stat だけ')
  state.now += 20_000
  state.sig = 'b'
  state.turns = [turn({ text: 'PR #610 を出しました', closed: true, endedAt: new Date(T0 + 5 * 60_000).toISOString() })]
  const got = await recovered.apply([input])
  assert.equal(state.tails, 2, '変わったら読む')
  assert.equal(got.rows.at(-1)?.text, 'PR #610 を出しました')
  await recovered.apply([input])
  assert.equal(state.tails, 2, '決まったらもう読まない')
  assert.equal(state.fulls, 0)
})

test('閉じたばかり（60 秒の待ち）のターンは、transcript が変わらなくても待ちが明けたら出す', async () => {
  const { state, recovered } = setup(turn({ text: 'できました', closed: true, endedAt: new Date(T0 + 10 * 60_000 - 5_000).toISOString() }))
  assert.equal((await recovered.apply([input])).key, '')
  state.now += 70_000
  assert.equal((await recovered.apply([input])).rows.at(-1)?.text, 'できました')
  assert.equal(state.tails, 2)
})

test('末尾に見当たらないターンは裏で頭から読むが、決まらなければ 5 分は読み直さない', async () => {
  const { state, recovered } = setup(turn({ startedAt: T0 + 30 * 60_000, input: '別の入力' }))
  await recovered.apply([input])
  await recovered.idle()
  assert.equal(state.fulls, 1)
  for (let i = 0; i < 3; i++) {
    state.now += 20_000
    state.sig = `c${i}`
    await recovered.apply([input])
    await recovered.idle()
  }
  assert.equal(state.fulls, 1, '回っているセッションの transcript を 15 秒ごとに頭から読まない')
})

test('頭から読んだターンが閉じたばかりなら、5 分ではなく次の間隔で見直す。時刻の読めない行は補わず、読み続けない', async () => {
  const next: FeedRow = { ...input, ts: '2026-10-01T11:09:30+09:00', user_text: '次の指示' }
  const { state, recovered } = setup(turn({ text: 'できました', closed: true, endedAt: new Date(T0 + 10 * 60_000 - 5_000).toISOString() }))
  await recovered.apply([input, next])
  await recovered.idle()
  assert.equal(state.fulls, 1)
  state.now += 70_000
  await recovered.apply([input, next])
  await recovered.idle()
  // 2 つ目の入力（最後のターン）のぶんも裏で読むので、回数ではなく「5 分待たずに出る」ことを見る
  assert.ok(state.fulls >= 2, '待ちが明けたらもう一度読む')
  assert.equal((await recovered.apply([input, next])).rows.find((r) => r.recovered)?.text, 'できました')

  const broken = setup(turn({ text: '返答', closed: true, endedAt: '' }))
  for (let i = 0; i < 4; i++) {
    await broken.recovered.apply([input])
    broken.state.now += 20_000
  }
  assert.equal(broken.state.tails, 1, '決まった（補わない）ので読み直さない')
})
