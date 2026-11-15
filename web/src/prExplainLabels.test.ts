import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrExplain } from '../../shared/types.ts'
import { explainButtonLabel, explainHref, explainNote, explainOpenHref, explainPaneEmpty } from './prExplainLabels.ts'

const ex = (o: Partial<PrExplain>): PrExplain => ({ state: 'ready', stale: false, session: 's@r', at: '', key: '0123456789abcdef', ...o })

test('explainButtonLabel: 回していなければ作る、回している間は押せない、終わったら作り直す', () => {
  assert.equal(explainButtonLabel(null), '解説を作る')
  assert.equal(explainButtonLabel(ex({ state: 'running' })), '')
  assert.equal(explainButtonLabel(ex({})), '作り直す')
  assert.equal(explainButtonLabel(ex({ state: 'gone' })), '作り直す')
  assert.equal(explainButtonLabel(ex({ state: 'failed' })), 'もう一度作る')
})

test('explainNote: 古い・消えた・見つからない・作っている', () => {
  assert.equal(explainNote(ex({})), '')
  assert.match(explainNote(ex({ stale: true })), /古い解説/)
  assert.match(explainNote(ex({ state: 'gone' })), /もうありません/)
  assert.match(explainNote(ex({ state: 'failed' })), /見つかりません/)
  assert.match(explainNote(ex({ state: 'running' })), /作っています/)
})

test('explainHref: 鍵だけで開く（パスを含めない）', () => {
  assert.equal(explainHref('0123456789abcdef'), '/api/pr-explain/0123456789abcdef')
})

test('explainPaneEmpty: 開けるときだけ空。ほかは理由と作り直す道を出す（#887）', () => {
  assert.equal(explainPaneEmpty(ex({}), true), '')
  assert.equal(explainPaneEmpty(ex({ stale: true }), true), '', '古くても開ける（古いことは見出しに出す）')
  assert.match(explainPaneEmpty(null, true), /まだありません.*作れます/)
  assert.match(explainPaneEmpty(null, false), /このマシンでは作れません/, '作るボタンが出ない PR では、作れるとは言わない')
  assert.match(explainPaneEmpty(ex({ state: 'running' }), true), /作っています/)
  assert.match(explainPaneEmpty(ex({ state: 'gone' }), true), /もうありません.*作り直せます/)
  assert.match(explainPaneEmpty(ex({ state: 'failed' }), true), /見つかりません.*作り直せます/)
  assert.match(explainPaneEmpty(ex({ key: undefined }), true), /開けません.*作り直せます/, '鍵が無ければ開かない')
  for (const state of ['gone', 'failed'] as const) {
    assert.doesNotMatch(explainPaneEmpty(ex({ state }), false), /作り直せます/, `作るボタンが出ない PR では、作り直せるとは言わない（${state}）`)
  }
})

test('explainOpenHref: ready で鍵があるときだけ開く先を返す（欄とペインが同じものを見る）', () => {
  assert.equal(explainOpenHref(ex({})), '/api/pr-explain/0123456789abcdef')
  assert.equal(explainOpenHref(ex({ stale: true })), '/api/pr-explain/0123456789abcdef')
  for (const e of [null, ex({ key: undefined }), ex({ state: 'running' }), ex({ state: 'gone' }), ex({ state: 'failed' })]) assert.equal(explainOpenHref(e), '')
})
