import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DRAFT_MAX_AGE_MS, DRAFT_MAX_COUNT, EMPTY_DRAFT, draftOf, isEmptyDraft, parseDrafts, withDraft } from './replyDrafts.ts'
import type { Drafts } from './replyDrafts.ts'

const NOW = Date.parse('2026-09-10T12:00:00+09:00')
const IMAGE = { path: '/home/u/.agent-feed/attachments/7c7dfbcf88dd8246/7c61e84ce8f8e2e3.png', url: '/api/attachments/7c7dfbcf88dd8246/7c61e84ce8f8e2e3.png' }

test('withDraft / draftOf: 書いた下書き（本文と画像）が読める。別の返信先には出ない（#306）', () => {
  const drafts = withDraft({}, 'a@sai', { text: 'A に送るつもり', attachments: [IMAGE] }, NOW)
  assert.deepEqual(draftOf(drafts, 'a@sai'), { text: 'A に送るつもり', attachments: [IMAGE] })
  assert.deepEqual(draftOf(drafts, 'b@sai'), EMPTY_DRAFT, 'A の下書きを B の入力欄に出さない')
  // 書き直すと置き換わる（増えない）
  const again = withDraft(drafts, 'a@sai', { text: '書き直した', attachments: [] }, NOW + 1)
  assert.deepEqual(Object.keys(again), ['a@sai'])
  assert.equal(draftOf(again, 'a@sai').text, '書き直した')
})

test('withDraft: 本文が空白だけで画像も無ければ消す。画像だけなら残す', () => {
  const drafts = withDraft({}, 'a@sai', { text: 'x', attachments: [] }, NOW)
  assert.deepEqual(withDraft(drafts, 'a@sai', { text: '  \n ', attachments: [] }, NOW), {}, '送った・消した')
  assert.deepEqual(draftOf(withDraft({}, 'a@sai', { text: '', attachments: [IMAGE] }, NOW), 'a@sai').attachments, [IMAGE])
  assert.equal(isEmptyDraft(EMPTY_DRAFT), true)
})

test(`withDraft: ${DRAFT_MAX_AGE_MS / 86_400_000} 日より古いものは、次に書くときに捨てる`, () => {
  const drafts: Drafts = {
    old: { text: '8 日前', attachments: [], at: NOW - DRAFT_MAX_AGE_MS - 1 },
    edge: { text: 'ちょうど 7 日前', attachments: [], at: NOW - DRAFT_MAX_AGE_MS },
  }
  const next = withDraft(drafts, 'a@sai', { text: '今', attachments: [] }, NOW)
  assert.deepEqual(Object.keys(next).sort(), ['a@sai', 'edge'])
  // 空を書いた（送った）ときも掃除はする
  assert.deepEqual(Object.keys(withDraft(drafts, 'a@sai', EMPTY_DRAFT, NOW)), ['edge'])
})

test(`withDraft: 残すのは新しい順に ${DRAFT_MAX_COUNT} 件まで`, () => {
  const drafts: Drafts = {}
  for (let i = 0; i < DRAFT_MAX_COUNT + 5; i++) drafts[`s${i}`] = { text: `${i}`, attachments: [], at: NOW - 1000 + i }
  const next = withDraft(drafts, 'new', { text: '一番新しい', attachments: [] }, NOW)
  assert.equal(Object.keys(next).length, DRAFT_MAX_COUNT)
  assert.equal(draftOf(next, 'new').text, '一番新しい', 'いま書いたものは必ず残る')
  assert.deepEqual(draftOf(next, 's0'), EMPTY_DRAFT, '一番古いものから捨てる')
  assert.equal(draftOf(next, `s${DRAFT_MAX_COUNT + 4}`).text, `${DRAFT_MAX_COUNT + 4}`)
})

test('parseDrafts: 壊れた値・形の違う値は空として読む（落とさない）', () => {
  assert.deepEqual(parseDrafts(null), {})
  assert.deepEqual(parseDrafts(''), {})
  assert.deepEqual(parseDrafts('{'), {})
  assert.deepEqual(parseDrafts('[]'), {})
  assert.deepEqual(parseDrafts('"text"'), {})
  assert.deepEqual(parseDrafts('{"a":{"text":1,"attachments":[],"at":1}}'), {}, '本文が文字列でない')
  assert.deepEqual(parseDrafts('{"a":{"text":"x","at":1}}'), {}, '画像の配列が無い')
  // 画像の中の形の違うものだけ落とし、余計なキーは持ち込まない
  const drafts = parseDrafts(JSON.stringify({ a: { text: 'x', at: 1, attachments: [IMAGE, { path: 1 }, null, { ...IMAGE, extra: true }] } }))
  assert.deepEqual(drafts.a?.attachments, [IMAGE, IMAGE])
  // 書いたものを読み直すと同じ
  const written = withDraft({}, 'a@sai', { text: 'x', attachments: [IMAGE] }, NOW)
  assert.deepEqual(parseDrafts(JSON.stringify(written)), written)
})

test('parseDrafts: __proto__ という鍵でも Object の prototype を書き換えない', () => {
  const drafts = parseDrafts('{"__proto__":{"text":"x","attachments":[],"at":1}}')
  assert.equal(Object.getPrototypeOf(drafts), Object.prototype)
  assert.equal(draftOf(drafts, '__proto__').text, 'x')
  assert.deepEqual(draftOf({}, '__proto__'), EMPTY_DRAFT, '持っていない鍵は prototype から拾わない')
})
