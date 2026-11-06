import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrExplain } from '../../shared/types.ts'
import { explainButtonLabel, explainHref, explainNote, explainStale } from './prExplainLabels.ts'

const ex = (o: Partial<PrExplain>): PrExplain => ({ state: 'ready', stale: false, head_sha: 'h1', session: 's@r', at: '', key: '0123456789abcdef', ...o })

test('explainButtonLabel: 回していなければ作る、回している間は押せない、終わったら作り直す', () => {
  assert.equal(explainButtonLabel(null), '解説を作る')
  assert.equal(explainButtonLabel(ex({ state: 'running' })), '')
  assert.equal(explainButtonLabel(ex({})), '作り直す')
  assert.equal(explainButtonLabel(ex({ state: 'gone' })), '作り直す')
  assert.equal(explainButtonLabel(ex({ state: 'failed' })), 'もう一度作る')
})

test('explainStale / explainNote: head が進んだら古い。消えた・見つからないも出す', () => {
  assert.equal(explainStale(ex({}), 'h1'), false)
  assert.equal(explainStale(ex({}), 'h2'), true)
  assert.equal(explainStale(ex({ stale: true }), ''), true)
  assert.equal(explainNote(ex({}), 'h1'), '')
  assert.match(explainNote(ex({}), 'h2'), /古い解説/)
  assert.match(explainNote(ex({ state: 'gone' }), 'h1'), /もうありません/)
  assert.match(explainNote(ex({ state: 'failed' }), 'h1'), /見つかりません/)
  assert.match(explainNote(ex({ state: 'running' }), 'h1'), /作っています/)
})

test('explainHref: 鍵だけで開く（パスを含めない）', () => {
  assert.equal(explainHref('0123456789abcdef'), '/api/pr-explain/0123456789abcdef')
})
