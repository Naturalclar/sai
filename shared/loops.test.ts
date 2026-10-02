import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isHandedOnly } from './agentMessages.ts'
import {
  clampInterval,
  isLoopPrompt,
  LOOP_DEFAULT_HOURS,
  LOOP_DEFAULT_INTERVAL_S,
  LOOP_DEFAULT_ROUNDS,
  LOOP_MARK,
  LOOP_MAX_INTERVAL_S,
  LOOP_MIN_INTERVAL_S,
  LOOP_STALL_ROUNDS,
  loopAfterRound,
  loopFromRequest,
  loopHalt,
  loopPrompt,
  loopPromptLabel,
  loopStatusLine,
  loopView,
} from './loops.ts'
import type { LoopState } from './loops.ts'

const NOW = Date.parse('2026-10-02T03:00:00Z') // 12:00 JST
const base: LoopState = { goal: 'PR を片付ける', until: 'open な PR が 0 件', max_rounds: 10, deadline: '2026-10-02T05:00:00.000Z', interval_s: 600, status: 'running', round: 1, since: '2026-10-02T03:00:00.000Z', turn: 't1' }

test('loopFromRequest: 目的と終わりの条件は必須。上限は省略すると既定値が入り、上限なしにはならない', () => {
  const made = loopFromRequest({ goal: ' PR を片付ける ', until: ' 0 件 ' }, NOW)
  assert.ok('loop' in made)
  assert.deepEqual(made.loop, { goal: 'PR を片付ける', until: '0 件', max_rounds: LOOP_DEFAULT_ROUNDS, deadline: new Date(NOW + LOOP_DEFAULT_HOURS * 3_600_000).toISOString(), interval_s: LOOP_DEFAULT_INTERVAL_S, status: 'running', round: 0, next_at: new Date(NOW).toISOString(), since: new Date(NOW).toISOString() })
  for (const bad of [null, {}, { goal: 'x' }, { until: 'x' }, { goal: 'x', until: 'y', max_rounds: '3' }, { goal: 'x', until: 'y', max_rounds: Infinity }, { goal: 'x', until: 'y', hours: -1 }, { goal: 'あ'.repeat(2001), until: 'y' }]) {
    assert.ok('error' in loopFromRequest(bad, NOW), JSON.stringify(bad))
  }
})

test('clampInterval: 下限と上限に丸める。数でなければ既定', () => {
  assert.equal(clampInterval(5), LOOP_MIN_INTERVAL_S)
  assert.equal(clampInterval(1e9), LOOP_MAX_INTERVAL_S)
  assert.equal(clampInterval(90.4), 90)
  assert.equal(clampInterval('300', 120), 120)
  assert.equal(clampInterval(NaN), LOOP_DEFAULT_INTERVAL_S)
  assert.equal(clampInterval(undefined, 5), LOOP_MIN_INTERVAL_S, '既定の側も丸める')
})

test('loopPrompt: 目的・終わりの条件・何周目か・申し送り・ツールの呼び方を毎周渡す。最後の周は「このあとは起こされない」', () => {
  const text = loopPrompt({ ...base, round: 3, note: '#12 をマージした' }, NOW)
  assert.ok(text.startsWith(`${LOOP_MARK}3 周目 / 上限 10 周（14:00 まで）`))
  assert.match(text, /目的: PR を片付ける\n終わりの条件: open な PR が 0 件\n前の周の申し送り: #12 をマージした/)
  assert.match(text, /sai_loop_next を 1 回呼んで/)
  assert.match(text, /呼ばずに終えると 10 分後にもう一度起こされます/)
  assert.match(loopPrompt({ ...base, round: 10 }, NOW), /これが上限の最後の周です/)
  assert.match(loopPrompt({ ...base, interval_s: 90 }, NOW), /90 秒後にもう一度/)
  assert.equal(isLoopPrompt(text), true)
  assert.equal(isLoopPrompt('【SAI】#o/r の「x」からのメッセージです（id: a1）'), false, 'セッション同士のメッセージの見出しとは取り違えない')
  assert.equal(loopPromptLabel(text), 'ループ 3 周目')
  assert.equal(loopPromptLabel('人が打った文'), '人が打った文')
  assert.equal(isHandedOnly(text), true, '人が打った文ではないので、題名・最後の入力・↑ の履歴に使わない')
})

test('loopAfterRound: 言われた秒で次の時刻を決める。言わなければ既定の間隔で、申し送りは前のまま', () => {
  const said = loopAfterRound({ ...base, said: { seconds: 120, note: '次は CI' } }, NOW)
  assert.deepEqual([said.status, said.next_at, said.note, said.turn, said.said], ['running', new Date(NOW + 120_000).toISOString(), '次は CI', undefined, undefined])
  const quiet = loopAfterRound({ ...base, note: '前の周', stalled: 1 }, NOW)
  assert.deepEqual([quiet.next_at, quiet.note, quiet.stalled], [new Date(NOW + 600_000).toISOString(), '前の周', 1], 'ツールを呼ばなかった周は「同じ」に数えない')
})

test('loopAfterRound: 上限の周を回り切ったら止まる。申し送りが同じまま続いたら止まり、変われば数え直す', () => {
  const capped = loopAfterRound({ ...base, round: 10, said: { seconds: 60, note: 'まだ' } }, NOW)
  assert.deepEqual([capped.status, capped.reason, capped.next_at, capped.note], ['stopped', '上限の 10 周を回りました', undefined, 'まだ'])

  let l: LoopState = { ...base, round: 1, said: { seconds: 60, note: '待ち' } }
  for (let round = 1; round < LOOP_STALL_ROUNDS; round++) {
    l = loopAfterRound(l, NOW)
    assert.equal(l.status, 'running', `${round} 周目`)
    l = { ...l, round: round + 1, turn: 't', said: { seconds: 60, note: '待ち' } }
  }
  const stalled = loopAfterRound(l, NOW)
  assert.equal(stalled.status, 'stopped')
  assert.match(stalled.reason!, /進んでいない/)
  const moved = loopAfterRound({ ...l, said: { seconds: 60, note: '進んだ' } }, NOW)
  assert.deepEqual([moved.status, moved.stalled], ['running', 0])
})

test('loopAfterRound: 一時停止のまま周が終わったら、申し送りだけ残して次の時刻は決めない', () => {
  const paused = loopAfterRound({ ...base, status: 'paused', reason: '人が送った', said: { seconds: 60, note: '途中' } }, NOW)
  assert.deepEqual([paused.status, paused.next_at, paused.note, paused.turn], ['paused', undefined, '途中', undefined])
})

test('loopHalt / loopView: 終わったら次の時刻と周のターンを消す。一時停止は周のターンを覚えたまま。画面には内側の値を出さない', () => {
  const live: LoopState = { ...base, next_at: 'x', said: { seconds: 60, note: 'n' }, stalled: 1, url: 'http://127.0.0.1:1' }
  assert.deepEqual(loopHalt(live, 'stopped', '人が止めました'), { goal: base.goal, until: base.until, max_rounds: 10, deadline: base.deadline, interval_s: 600, status: 'stopped', round: 1, since: base.since, stalled: 1, url: 'http://127.0.0.1:1', reason: '人が止めました' })
  const paused = loopHalt(live, 'paused', '人が送った')
  assert.deepEqual([paused.turn, paused.said, paused.next_at], ['t1', { seconds: 60, note: 'n' }, undefined])
  assert.deepEqual(loopView(live), { goal: base.goal, until: base.until, max_rounds: 10, deadline: base.deadline, interval_s: 600, status: 'running', round: 1, since: base.since, next_at: 'x', turning: true })
})

test('loopStatusLine: 画面の 1 行', () => {
  assert.equal(loopStatusLine({ ...loopView(base) }, NOW), 'ループ中: 1 周目 / 上限 10・いま回っています・14:00 まで')
  assert.equal(loopStatusLine({ ...loopView({ ...base, turn: undefined }), next_at: '2026-10-02T03:30:00Z' }, NOW), 'ループ中: 1 周目 / 上限 10・次は 12:30・14:00 まで')
  assert.equal(loopStatusLine({ ...loopView({ ...base, turn: undefined }), status: 'done' }, NOW), 'ループ完了: 1 周目 / 上限 10')
  assert.equal(loopStatusLine({ ...loopView({ ...base, turn: undefined }), deadline: '2026-10-03T03:00:00Z', status: 'paused' }, NOW), 'ループ一時停止: 1 周目 / 上限 10・10/3 12:00 まで')
})
