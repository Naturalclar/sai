import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appeared, notifyKey, notifyPlan, titleWith } from './notify.ts'
import type { TodoItem } from './todoItems.ts'
import type { SessionSummary } from '../../shared/types.ts'

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
