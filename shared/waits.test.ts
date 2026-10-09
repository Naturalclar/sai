import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isHandedOnly } from './agentMessages.ts'
import { failingChecks, parsePrCi } from './prs.ts'
import type { Wait } from './types.ts'
import {
  isWaitPrompt, WAIT_DAY_MS, WAIT_EMPTY_GRACE_MS, WAIT_FAILING_MAX, WAIT_MARK, WAIT_MAX_PER_SESSION, WAIT_THEN_MAX, WAIT_WAKES_PER_DAY,
  WAIT_AUTO_WAKE_MS, WAIT_MAX_MS, waitConfirmed, waitFinishedLate, waitFromRequest, waitLateReason, waitLimitRefusal, waitLive, waitOutcome, waitPrompt, waitPromptLabel, waitStatusLine, waitView, waitWakeable, wakesExhausted,
} from './waits.ts'
import type { WaitState } from './waits.ts'

const T0 = Date.parse('2026-10-07T00:00:00.000Z')
const base: WaitState = { id: 'w1', repo: 'o/r', pr: 12, then: '結果を読んで報告する', status: 'waiting', since: new Date(T0).toISOString(), deadline: new Date(T0 + 2 * 3_600_000).toISOString() }

test('waitFromRequest: PR の番号と 1 文だけ。長さ・間隔・リポジトリは受けない', () => {
  assert.deepEqual(waitFromRequest({ pr: 12, then: ' 結果を\n読む ' }), { pr: 12, then: '結果を 読む' })
  assert.deepEqual(waitFromRequest({ pr: '12', then: 'x', repo: 'evil/x', deadline: '2099' }), { pr: 12, then: 'x' })
  for (const pr of [0, -3, 1.5, NaN, '', 'x', '1e3', null, undefined, {}]) assert.ok('error' in waitFromRequest({ pr, then: 'x' }), String(pr))
  assert.ok('error' in waitFromRequest({ pr: 1, then: '  ' }))
  assert.ok('error' in waitFromRequest({ pr: 1 }))
  assert.ok('error' in waitFromRequest({ pr: 1, then: 'あ'.repeat(WAIT_THEN_MAX + 1) }))
  assert.ok(!('error' in waitFromRequest({ pr: 1, then: 'あ'.repeat(WAIT_THEN_MAX) })))
  assert.ok('error' in waitFromRequest(null))
})

test('waitLimitRefusal / wakesExhausted: 同じ PR は 1 つ・同時の数・1 日の回数。片付いた待ちは数えない', () => {
  const own = (status: Wait['status'], pr: number) => ({ status, pr, repo: 'o/r' })
  assert.equal(waitLimitRefusal([], 'o/r', 1), '')
  assert.match(waitLimitRefusal([own('waiting', 1)], 'O/R', 1), /もう待っています/, 'リポジトリ名は大文字小文字を見ない')
  assert.equal(waitLimitRefusal([own('expired', 1), own('halted', 2)], 'o/r', 1), '', '終わった待ちは数えない・同じ PR をもう一度預けられる')
  const full = Array.from({ length: WAIT_MAX_PER_SESSION }, (_, i) => own(i % 2 ? 'ready' : 'waiting', i + 1))
  assert.match(waitLimitRefusal(full, 'o/r', 99), new RegExp(`${WAIT_MAX_PER_SESSION} 件まで`))
  const now = T0
  const wakes = Array.from({ length: WAIT_WAKES_PER_DAY }, (_, i) => now - i * 60_000)
  assert.equal(wakesExhausted(wakes, now), true)
  assert.equal(wakesExhausted(wakes.slice(1), now), false)
  assert.equal(wakesExhausted(wakes, now + WAIT_DAY_MS), false, '24 時間より前は数えない')
  assert.deepEqual([waitLive('waiting'), waitLive('ready'), waitLive('waking'), waitLive('expired'), waitLive('halted')], [true, true, true, false, false])
  assert.deepEqual([waitWakeable('waiting'), waitWakeable('ready'), waitWakeable('waking'), waitWakeable('expired'), waitWakeable('halted')], [true, true, false, false, true])
})

test('waitOutcome: 通った・落ちた・マージ・クローズで終わり。チェックなしは猶予のあとだけ', () => {
  const ci = (state: string, checks: 'success' | 'failure' | 'pending' | '', pending = checks === 'pending') => ({ state, checks, failing: [], pending })
  assert.equal(waitOutcome(ci('OPEN', 'pending'), T0, T0 + 9_999_999), null)
  assert.equal(waitOutcome(ci('OPEN', 'success'), T0, T0), 'success')
  assert.equal(waitOutcome(ci('OPEN', 'failure'), T0, T0), 'failure')
  assert.equal(waitOutcome(ci('MERGED', 'pending'), T0, T0), 'merged')
  assert.equal(waitOutcome(ci('closed', 'pending'), T0, T0), 'closed')
  assert.equal(waitOutcome(ci('OPEN', ''), T0, T0 + WAIT_EMPTY_GRACE_MS - 1), null, '出した直後はまだ載っていない')
  assert.equal(waitOutcome(ci('OPEN', ''), T0, T0 + WAIT_EMPTY_GRACE_MS), 'none')
  assert.equal(waitOutcome(ci('OPEN', 'failure', true), T0, T0), null, '1 つ落ちていても、走っているチェックがあれば「まだ」')
  assert.equal(waitOutcome(ci('MERGED', 'failure', true), T0, T0), 'merged')
  // 「通った」「落ちた」は続けて 2 回同じに見えてから。時間切れの前の最後の 1 回はそのまま
  assert.equal(waitConfirmed('success', undefined, false), null)
  assert.equal(waitConfirmed('success', 'success', false), 'success')
  assert.equal(waitConfirmed('failure', 'success', false), null, '変わったら数え直す')
  assert.equal(waitConfirmed('failure', 'failure', false), 'failure')
  assert.equal(waitConfirmed('failure', undefined, true), 'failure')
  assert.equal(waitConfirmed('merged', undefined, false), 'merged')
  assert.equal(waitConfirmed('none', undefined, false), 'none')
  assert.equal(waitConfirmed(null, 'success', true), null)
})

test('waitPrompt: 頭は印。結果の要点と落ちたチェックの名前だけで、やってよいのは報告まで。人が打った文としては扱わない', () => {
  const failing = Array.from({ length: WAIT_FAILING_MAX + 3 }, (_, i) => `job-${i}`)
  const red = waitPrompt({ ...base, result: 'failure', failing })
  assert.ok(red.startsWith(`${WAIT_MARK}PR #12（o/r）: CI が落ちました\n落ちたチェック: job-0 / job-1`))
  assert.ok(!red.includes(`job-${WAIT_FAILING_MAX}`), '名前は決めた数まで')
  assert.match(red, /預けたときに書いたこと: 結果を読んで報告する/)
  assert.match(red, /マージはせず、別のセッションへ送ることも、次の待ちを預けることもしないでください/)
  const green = waitPrompt({ ...base, result: 'success', failing: ['x'] })
  assert.ok(!green.includes('落ちたチェック'), '通ったときは出さない')
  assert.match(waitPrompt(base), /CI はまだ終わっていません（人がいま起こしました）/)
  assert.equal(isWaitPrompt(red), true)
  assert.equal(isWaitPrompt('PR #12 の CI を見て'), false)
  assert.equal(isHandedOnly(red), true, '題名・最後の入力・↑ の履歴に使わない')
  assert.equal(waitPromptLabel(red), '待ちが終わった: PR #12')
  assert.equal(waitPromptLabel('ふつうの文'), 'ふつうの文')
})

test('waitView / waitStatusLine: サーバだけの項目は画面に出さない。状態ごとの 1 行', () => {
  const view = waitView({ ...base, next_check_at: 'x', failing: ['a'], url: 'http://127.0.0.1:1', seen_once: 'success', checked_at: 'y' })
  assert.deepEqual(Object.keys(view).sort(), ['deadline', 'id', 'pr', 'repo', 'since', 'status', 'then'])
  assert.equal(waitStatusLine(base, T0 + 40 * 60_000), 'PR #12 の CI を待っています（あと 1 時間 20 分で諦めます）')
  assert.equal(waitStatusLine(base, T0 + 100 * 60_000), 'PR #12 の CI を待っています（あと 20 分で諦めます）')
  assert.equal(waitStatusLine({ ...base, status: 'ready', result: 'success' }, T0), 'PR #12 の CI: CI は全部通りました。まだ起こしていません')
  assert.equal(waitStatusLine({ ...base, status: 'ready', result: 'failure', late: true }, T0), 'PR #12 の CI は終わっています（CI が落ちました）。自動では起こしません')
  assert.equal(waitView({ ...base, status: 'ready', late: true }).late, true, '自動では起こさない印は画面に渡す')
  assert.match(waitStatusLine({ ...base, status: 'expired' }, T0), /終わりませんでした（起こしていません）/)
  assert.match(waitStatusLine({ ...base, status: 'halted' }, T0), /起こせませんでした/)
})

test('waitFinishedLate: 待ち始めてから決めた時間を過ぎて終わったか。線の上までは自動で起こす側。預かった時刻が読めなければ起こさない側', () => {
  assert.equal(waitFinishedLate(base.since, T0), false)
  assert.equal(waitFinishedLate(base.since, T0 + WAIT_AUTO_WAKE_MS), false)
  assert.equal(waitFinishedLate(base.since, T0 + WAIT_AUTO_WAKE_MS + 1), true)
  assert.equal(waitFinishedLate('', T0), true)
  // 境目（キャッシュの寿命の 1 時間）より手前に置く。待てる長さより短くないと、過ぎて終わる待ちが無い
  assert.ok(WAIT_AUTO_WAKE_MS < 60 * 60_000 && WAIT_AUTO_WAKE_MS < WAIT_MAX_MS)
  assert.match(waitLateReason(), /50 分を過ぎて終わったので、自動では起こしません/)
})

test('parsePrCi / failingChecks: gh pr view --json state,statusCheckRollup を読む。落ちたチェックの名前だけ拾う', () => {
  const rollup = [
    { __typename: 'CheckRun', name: 'node (test)', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'feed', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'deploy/preview', state: 'ERROR' },
    { __typename: 'CheckRun', name: 'node (test)', status: 'COMPLETED', conclusion: 'CANCELLED' },
    { __typename: 'CheckRun', name: 'slow', status: 'IN_PROGRESS', conclusion: '' },
  ]
  assert.deepEqual(failingChecks(rollup), ['node (test)', 'deploy/preview'])
  assert.deepEqual(parsePrCi(JSON.stringify({ state: 'OPEN', statusCheckRollup: rollup })), { state: 'OPEN', checks: 'failure', failing: ['node (test)', 'deploy/preview'], pending: true })
  assert.deepEqual(parsePrCi('{"state":"MERGED","statusCheckRollup":[]}'), { state: 'MERGED', checks: '', failing: [], pending: false })
  assert.deepEqual(parsePrCi('{"state":"OPEN"}'), { state: 'OPEN', checks: '', failing: [], pending: false })
  for (const bad of ['', 'not json', '[]', '{}', '{"state":1}']) assert.equal(parsePrCi(bad), null, bad)
})
