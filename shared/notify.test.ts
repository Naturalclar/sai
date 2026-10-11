import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appeared, notifyKey, notifyPlan, seenAfter, titleWith } from './notify.ts'
import type { TodoItem } from './todoItems.ts'
import type { SessionSummary } from './types.ts'

function item(over: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 'S1@dev',
    kind: 'watch',
    text: '許可待ち: Bash: rm -rf node_modules',
    since: '2026-09-09T10:00:00+09:00',
    session: { title: 'CI の整備' } as SessionSummary,
    approval: null,
    replyable: true,
    ...over,
  }
}

test('titleWith: 件数は先頭（タブが狭いと後ろから消えるため）。0 件なら付けない', () => {
  assert.equal(titleWith(0), 'SAI')
  assert.equal(titleWith(2), '(2) SAI')
  assert.equal(titleWith(0, 'abc123'), 'SAI · abc123')
  assert.equal(titleWith(1, 'abc123'), '(1) SAI · abc123')
})

test('notifyKey: 待ち始めた時刻まで見る（答えたあと再び待てば別物、待ち続けている間は同じ）', () => {
  const a = item()
  assert.equal(notifyKey(a), notifyKey(item()), '同じ待ちは同じ鍵＝鳴り続けない')
  assert.notEqual(notifyKey(a), notifyKey(item({ since: '2026-09-09T11:00:00+09:00' })))
  assert.notEqual(notifyKey(a), notifyKey(item({ kind: 'answer' })), '種類が違えば別物')
  assert.notEqual(notifyKey(a), notifyKey(item({ id: 'S2@dev' })))
})

test('appeared: seen に無いものだけ', () => {
  const a = item({ id: 'A@dev' })
  const b = item({ id: 'B@dev' })
  assert.deepEqual(appeared(new Set(), [a, b]).map((t) => t.id), ['A@dev', 'B@dev'])
  assert.deepEqual(appeared(new Set([notifyKey(a)]), [a, b]).map((t) => t.id), ['B@dev'])
  assert.deepEqual(appeared(new Set([notifyKey(a), notifyKey(b)]), [a, b]), [])
  assert.deepEqual(appeared(new Set(), []), [])
})

test('notifyPlan: 1 件はその中身、2 件以上はまとめて 1 通', () => {
  assert.equal(notifyPlan([]), null)

  const one = notifyPlan([item()])
  assert.equal(one?.title, '待機中: CI の整備')
  assert.equal(one?.body, '許可待ち: Bash: rm -rf node_modules')
  assert.equal(one?.hash, '#/todo')

  assert.equal(notifyPlan([item({ kind: 'answer' })])?.title, '答え待ち: CI の整備')

  const many = notifyPlan([item({ id: 'A@dev' }), item({ id: 'B@dev', kind: 'answer' })])
  assert.equal(many?.title, '2 件があなたを待っています')
  assert.match(many?.body ?? '', /1 件は答え待ち/)
  assert.equal(many?.tag, 'sai-todo', 'まとめた通知は積み上がらない')
})

test('notifyPlan: 一覧から消えているセッションは ID を出す（答え待ちは絞り込みを通っていない）', () => {
  const plan = notifyPlan([item({ kind: 'answer', session: null, id: 'gone@dev' })])
  assert.equal(plan?.title, '答え待ち: gone@dev')
})

test('notifyPlan: 表示名があれば優先し、無ければタイトル', () => {
  const named = notifyPlan([item({ session: { title: 'CI の整備', meta: { name: '画像を添える' } } as SessionSummary })])
  assert.equal(named?.title, '待機中: 画像を添える')
})

test('appeared: 終わって次を待っているだけ（done）では鳴らさない（#438）', () => {
  // ターンが終われば必ず 60 秒後に `入力待ち` の行が来るので、落とさないと返信のたびに通知が鳴る
  const done = item({ id: 'A@dev', kind: 'done', text: '入力待ち' })
  const real = item({ id: 'B@dev' })
  assert.deepEqual(appeared(new Set(), [done]), [])
  assert.deepEqual(appeared(new Set(), [done, real]).map((t) => t.id), ['B@dev'])
})

test('notifyPlan: done しか無ければ通知は組み立たない（#438）', () => {
  const done = item({ id: 'A@dev', kind: 'done', text: '入力待ち' })
  assert.equal(notifyPlan(appeared(new Set(), [done])), null)
})

// ---- #732: 終わったのに自動では起こさない待ち

const lateWait = (id: string, over: Partial<TodoItem> = {}): TodoItem =>
  item({ kind: 'wait', text: 'PR #12 の CI は終わっています（CI は全部通りました）', replyable: false, wait: { id, repo: 'owner-a/repo-a', pr: 12, then: '報告する', status: 'ready', result: 'success', late: true, since: '2026-09-09T09:00:00+09:00', deadline: '2026-09-09T11:00:00+09:00' }, ...over })

test('notifyKey / seenAfter: 終わった待ちは 1 つの待ちにつき 1 回。並びから消えて戻っても（サーバの立て直しなど）鳴り直さない', () => {
  const a = lateWait('w1')
  // 鍵は待ちの id。終わった時刻の出方が変わっても同じ待ち
  assert.equal(notifyKey(a), notifyKey(lateWait('w1', { since: '2026-09-09T12:00:00+09:00' })))
  assert.notEqual(notifyKey(a), notifyKey(lateWait('w2')), '同じセッションの別の待ちは別に知らせる')
  let seen = seenAfter(new Set(), [])
  assert.deepEqual(appeared(seen, [a]).map(notifyKey), [notifyKey(a)], '終わったら 1 回知らせる')
  seen = seenAfter(seen, [a])
  assert.deepEqual(appeared(seen, [a]), [])
  // 取得が 1 回空になって戻る
  seen = seenAfter(seen, [])
  assert.deepEqual(appeared(seen, [a]), [], '同じ待ちでは鳴り直さない')
  // ほかの待ちは今までどおり、消えて戻れば新しい待ち（覚えるのは並んでいる間だけ）
  const w = item()
  seen = seenAfter(seenAfter(seenAfter(seen, [w]), []), [])
  assert.deepEqual(appeared(seen, [w, a]).map(notifyKey), [notifyKey(w)])
})

test('notifyPlan: 終わった待ち 1 件は「待ちが終わった」と結果を出す。行き先は要対応', () => {
  const plan = notifyPlan([lateWait('w1')])!
  assert.deepEqual([plan.title, plan.body, plan.hash], ['待ちが終わった: CI の整備', 'PR #12 の CI は終わっています（CI は全部通りました）', '#/todo'])
})
