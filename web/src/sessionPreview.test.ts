import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Replying } from '../../shared/types.ts'
import { sessionPreview } from './sessionPreview.ts'

const T = (min: number) => new Date(Date.UTC(2026, 8, 10, 3, min)).toISOString()

/** 2 ターン終わったセッション。最後のターン完了は 10 分 */
const base = { turns: 2, last_text: '**青**にした', last_turn_ts: T(10), last_user_text: '青にして', last_user_ts: T(10) }

test('sessionPreview: 返信が無ければエージェントの最後の返答（Markdown の記号は落とす）', () => {
  assert.deepEqual(sessionPreview(base, null), { from: 'agent', text: '青にした' })
})

test('sessionPreview: 記録された自分の入力がターン完了より新しければ、自分の返信を出す（Claude の入力の行）', () => {
  const s = { ...base, last_user_text: '次は赤にして', last_user_ts: T(12) }
  assert.deepEqual(sessionPreview(s, null), { from: 'me', who: 'あなた', text: '次は赤にして' })
  assert.equal(sessionPreview(s, null, { name: 'じぇし' })?.who, 'じぇし', 'プロフィールの名前があればそれ')
})

test('sessionPreview: ターン完了の行に載っている入力（同じ時刻）は返答の方を出す（Codex / OpenCode）', () => {
  assert.equal(sessionPreview(base, null)?.from, 'agent')
})

test('sessionPreview: SAI から送った返信は、送った瞬間から出す（行がまだ無いエージェントでも）', () => {
  const replying: Replying = { since: T(11), text: 'テストも足して' }
  assert.deepEqual(sessionPreview({ ...base, last_user_text: undefined, last_user_ts: undefined }, replying), { from: 'me', who: 'あなた', text: 'テストも足して' })
})

test('sessionPreview: 返信より後にターンが終わっていれば返答に戻る。失敗した返信は出さない', () => {
  assert.equal(sessionPreview(base, { since: T(9), text: '前の返信' })?.from, 'agent', '処理中の印が消える前にターン完了が届いた')
  assert.equal(sessionPreview(base, { since: T(11), text: '届かなかった', failed: { code: 1, tail: 'boom' } })?.from, 'agent')
})

test('sessionPreview: 最初の指示は出さない（題名と同じ文が 2 行並ぶだけ）', () => {
  const fresh = { turns: 0, last_text: '', last_user_text: '始めて', last_user_ts: T(1) }
  assert.equal(sessionPreview(fresh, null), null)
  assert.equal(sessionPreview(fresh, { since: T(1), text: '始めて' }), null)
})

test('sessionPreview: 1 ターン目のあとの返信は出す。返答は今までどおり 2 ターン目から', () => {
  const one = { ...base, turns: 1 }
  assert.equal(sessionPreview(one, null), null, '1 ターンだけなら 2 行目は出さない（今までどおり）')
  assert.equal(sessionPreview({ ...one, last_user_text: '続けて', last_user_ts: T(11) }, null)?.text, '続けて')
})

test('sessionPreview: 一言はエージェントの発言にだけ使う', () => {
  const s = { ...base, last_summary: '青にしたよ！' }
  assert.equal(sessionPreview(s, null)?.text, '青にしたよ！')
  assert.equal(sessionPreview({ ...s, last_user_text: '赤も', last_user_ts: T(12) }, null)?.text, '赤も', '自分の返信に一言は出さない')
})

test('sessionPreview: 画像を添えた返信は、本文の末尾に足したパスを出さない', () => {
  const replying: Replying = { since: T(11), text: 'このスクショを見て\n\n/Users/me/.agent-feed/attachments/abc/def.png' }
  const text = sessionPreview(base, replying)?.text ?? ''
  assert.equal(text.includes('.png'), false)
})

test('sessionPreview: 一言の中の Markdown も記号を落とす（LLM が本文の [名前](パス) を写す。#321）', () => {
  const s = { ...base, last_summary: 'Codex用アイコン作成！[codex-agent-icon.png](/Users/me/docs/assets/codex-agent-icon.png) **完成**' }
  assert.equal(sessionPreview(s, null)?.text, 'Codex用アイコン作成！codex-agent-icon.png 完成')
})
