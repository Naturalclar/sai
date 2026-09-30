import { test } from 'node:test'
import assert from 'node:assert/strict'
import { todoItems } from '../../shared/todoItems.ts'
import type { SessionSummary } from '../../shared/types.ts'
import { sourceTs } from './todoRowSource.ts'

const TS = '2026-09-30T12:00:00+09:00'

/** 終わったセッション（最後の行がターン完了）。一覧に要る項目だけ埋める */
const done = (over: Partial<SessionSummary>): SessionSummary =>
  ({ id: 's1@sai', end: TS, last_turn_ts: TS, last_kind: 'turn', last_text: '本文の1行目', idle: '', waiting: '', host: '', session_source: 'payload', agent: 'claude', ...over }) as SessionSummary

const rowOf = (s: SessionSummary) => {
  const item = todoItems([s], {}, 'mac', {}).find((i) => i.id === s.id)
  assert.ok(item, '前提: 行が出る')
  return item
}

test('sourceTs: 一言（要約）が出ている「終了」の行だけ、そのもとのターンの ts を返す（#537）', () => {
  const summarized = rowOf(done({ last_summary: '直してPRを出したよ' }))
  assert.equal(summarized.text, '直してPRを出したよ', '前提: 行には一言が出ている')
  assert.equal(sourceTs(summarized), TS)

  // 一言が無い（切っている・まだ作っていない）行は、元から本文の 1 行目が出ている
  const plain = rowOf(done({}))
  assert.equal(plain.text, '本文の1行目')
  assert.equal(sourceTs(plain), '')

  // 入力待ち（端末で放置）はその文言が出ているので、一言があっても出さない
  const idle = rowOf(done({ idle: '入力待ち', last_summary: '直してPRを出したよ' }))
  assert.equal(idle.text, '入力待ち')
  assert.equal(sourceTs(idle), '')
})

test('sourceTs: 上段（待っている行）には出さない。待ちの文言は要約ではない', () => {
  assert.equal(sourceTs({ kind: 'watch', session: done({ last_summary: 'x' }) }), '')
  assert.equal(sourceTs({ kind: 'answer', session: done({ last_summary: 'x' }) }), '')
  assert.equal(sourceTs({ kind: 'done', session: null }), '')
})
