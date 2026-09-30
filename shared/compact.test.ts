import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canCompact, COMPACT_MIN_TOKENS, compactPrompt, sendModes, startsNewWork } from './compact.ts'
import { CONTEXT_WARN_TOKENS } from './contextSize.ts'

test('startsNewWork: 実データの着手の形は当たる（#579）', () => {
  for (const t of ['着手して', '526着手して', '#526 着手して', '386に着手して', '482 に着手して', '540対応して', '334対応して', '529を着手して', '着手してください', '579に着手して。', '着手して\n補足: まず調べて']) {
    assert.equal(startsNewWork(t), true, t)
  }
})

test('startsNewWork: 狭く倒す。続きの指示・人への依頼・着手と関係ない文は当たらない（#579）', () => {
  for (const t of ['修正も着手して', 'かなでのセッションで564着手', 'マージして', '対応して', 'レビューに対応して', '着手する前に調べて', 'issue 追加。着手して', '', '  ']) {
    assert.equal(startsNewWork(t), false, t)
  }
})

const big = COMPACT_MIN_TOKENS + 1
const claude = { agent: 'claude', terminal: false }

test('sendModes: 着手 × Claude × 下限以上なら要約してから送るが既定（#579）', () => {
  assert.deepEqual(sendModes({ ...claude, text: '579着手して', contextTokens: big }, CONTEXT_WARN_TOKENS), { mode: 'compact', choices: ['compact', 'plain', 'new'] })
})

test('sendModes: 小さい・量が分からない・端末で開いている・Claude でないときは要約しない（#579）', () => {
  assert.deepEqual(sendModes({ ...claude, text: '579着手して', contextTokens: COMPACT_MIN_TOKENS - 1 }, CONTEXT_WARN_TOKENS), { mode: 'plain', choices: ['plain', 'new'] }, '新しいセッションは選べる')
  assert.deepEqual(sendModes({ ...claude, text: '579着手して', contextTokens: 0 }, CONTEXT_WARN_TOKENS).mode, 'plain')
  assert.deepEqual(sendModes({ ...claude, terminal: true, text: '579着手して', contextTokens: big }, CONTEXT_WARN_TOKENS).mode, 'plain')
  assert.deepEqual(sendModes({ agent: 'codex', terminal: false, text: '579着手して', contextTokens: big }, CONTEXT_WARN_TOKENS), { mode: 'plain', choices: [] }, 'Codex は対象外')
})

test('sendModes: 着手でなければそのまま。警告を超えていれば要約を横に出す（#579）', () => {
  assert.deepEqual(sendModes({ ...claude, text: 'マージして', contextTokens: big }, CONTEXT_WARN_TOKENS), { mode: 'plain', choices: [] }, '何も出さない')
  assert.deepEqual(sendModes({ ...claude, text: 'マージして', contextTokens: CONTEXT_WARN_TOKENS }, CONTEXT_WARN_TOKENS), { mode: 'plain', choices: ['compact', 'plain', 'new'] })
})

test('canCompact', () => {
  assert.equal(canCompact({ agent: 'claude', terminal: false, contextTokens: COMPACT_MIN_TOKENS }), true)
  assert.equal(canCompact({ agent: 'claude', terminal: true, contextTokens: COMPACT_MIN_TOKENS }), false)
})

test('compactPrompt: /compact に次に取りかかることを添える（1 行目だけ）', () => {
  const p = compactPrompt('579着手して\n詳しくは本文')
  assert.match(p, /^\/compact /)
  assert.match(p, /「579着手して」/)
  assert.doesNotMatch(p, /詳しくは本文/)
})
