import { test } from 'node:test'
import assert from 'node:assert/strict'
import { briefButtonLabel, newerBrief } from './prBriefLabels.ts'
import type { PrBrief } from '../../shared/types.ts'

const brief = (at: string): PrBrief => ({ text: 't', head_sha: 'a', at, comments: 0, notes: [], via: '' })

test('ボタン: まだ無ければ「作る」、古い・コメントが増えたら「作り直す」、いまの材料で作ってあれば出さない', () => {
  assert.equal(briefButtonLabel(false, null), '要約を作る')
  assert.equal(briefButtonLabel(true, { stale: true, added: 0 }), '要約を作り直す')
  assert.equal(briefButtonLabel(true, { stale: false, added: 2 }), '要約を作り直す')
  assert.equal(briefButtonLabel(true, { stale: false, added: 0 }), '')
})

test('この画面で作ったものとサーバが覚えていたもののうち、新しい方を出す', () => {
  const a = brief('2026-01-02T00:00:00Z')
  const b = brief('2026-01-03T00:00:00Z')
  assert.equal(newerBrief(a, b), b)
  assert.equal(newerBrief(b, a), b)
  assert.equal(newerBrief(null, a), a)
  assert.equal(newerBrief(a, null), a)
  assert.equal(newerBrief(null, null), null)
})
