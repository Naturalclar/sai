import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PendingQuestion } from '../../shared/types.ts'
import { questionsFor, rowQuestions } from './terminalQuestion.ts'

const pending: PendingQuestion = {
  input: { questions: [{ question: 'どう進めますか？', header: 'PR 1', options: [{ label: 'コミットしてPR作成 (Recommended)', description: 'push して PR を作る' }, { label: 'まだコミットしない' }] }] },
  asked_at: '2026-09-11T06:44:49.584Z',
  text: '質問: どう進めますか？',
}

test('questionsFor: まだ解消していない、同じ文の待ちのバブルに質問を出す。推奨の印は label から落として印にする（#333）', () => {
  const qs = questionsFor({ waiting: true, resolved: false, text: '質問: どう進めますか？' }, pending)
  assert.equal(qs?.length, 1)
  assert.equal(qs?.[0]?.header, 'PR 1')
  assert.deepEqual(
    qs?.[0]?.options.map((o) => [o.label, o.recommended, o.description]),
    [
      ['コミットしてPR作成', true, 'push して PR を作る'],
      ['まだコミットしない', false, ''],
    ],
  )
})

test('questionsFor: 質問が無い・待ちでない・解消した・文が違う・形が読めないときは出さない', () => {
  const waiting = { waiting: true, resolved: false, text: '質問: どう進めますか？' }
  assert.equal(questionsFor(waiting, undefined), null)
  assert.equal(questionsFor({ ...waiting, waiting: false }, pending), null, 'エージェントの返答のバブル')
  assert.equal(questionsFor({ ...waiting, resolved: true }, pending), null, '前に聞いた同じ文の質問（後に行が来た）')
  assert.equal(questionsFor({ ...waiting, text: '質問: 別の質問？' }, pending), null)
  assert.equal(questionsFor(waiting, { ...pending, input: { questions: 'broken' } }), null)
})

test('rowQuestions: 行に載った質問（#334）を、まだ解消していない待ちのバブルに出す。推奨の印も同じく読む', () => {
  const row = {
    questions: [{ question: 'どう進めますか？', header: 'PR 1', multiSelect: false, options: [{ label: 'コミットしてPR作成 (Recommended)', description: 'push して PR を作る' }, { label: 'まだコミットしない', description: '' }] }],
  }
  const qs = rowQuestions({ waiting: true, resolved: false, row })
  assert.equal(qs?.[0]?.header, 'PR 1')
  assert.deepEqual(qs?.[0]?.options.map((o) => [o.label, o.recommended]), [['コミットしてPR作成', true], ['まだコミットしない', false]])
  assert.equal(rowQuestions({ waiting: true, resolved: true, row }), null, '解消した待ちには出さない')
  assert.equal(rowQuestions({ waiting: false, row }), null)
  assert.equal(rowQuestions({ waiting: true, row: {} }), null, '載っていない古い行は null（#333 に落とす）')
  assert.equal(rowQuestions({ waiting: true, row: { questions: [] } }), null)
})
