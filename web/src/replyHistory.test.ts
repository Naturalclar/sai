import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOT_IN_HISTORY, canGoBack, canGoForward, historyFrom, stepHistory } from './replyHistory.ts'
import type { HistoryState } from './replyHistory.ts'
import type { FeedRow } from '../../shared/types.ts'

function row(over: Partial<FeedRow>): FeedRow {
  return {
    ts: '2026-09-09T10:00:00+09:00',
    agent: 'claude',
    repo: 'sai',
    branch: 'main',
    session: 's1',
    session_source: 'payload',
    cwd: '/tmp/sai',
    event: 'Stop',
    text: '返答',
    ...over,
  }
}

test('historyFrom: その返信先の user_text を新しい順に。連続する重複は畳む', () => {
  const rows = [
    row({ ts: '10:01', user_text: '古い指示' }),
    row({ ts: '10:02', session: 'other', user_text: '別セッション' }),
    row({ ts: '10:03', event: 'UserPromptSubmit', user_text: '同じ文', text: '' }),
    row({ ts: '10:04', user_text: '同じ文' }),
    row({ ts: '10:05', user_text: '' }),
    row({ ts: '10:06', user_text: '  新しい指示  ' }),
  ]
  assert.deepEqual(historyFrom(rows, 's1@sai'), ['新しい指示', '同じ文', '古い指示'])
  assert.deepEqual(historyFrom(rows, 'other@sai'), ['別セッション'])
  assert.deepEqual(historyFrom(rows, 'nope@sai'), [])
  assert.deepEqual(historyFrom([], 's1@sai'), [])
})

test('historyFrom: 送った直後のまだ行が届いていない分を先頭に足す。同じなら重ねない', () => {
  const rows = [row({ ts: '10:01', user_text: '一つ前' })]
  assert.deepEqual(historyFrom(rows, 's1@sai', ['さっき送った']), ['さっき送った', '一つ前'])
  assert.deepEqual(historyFrom(rows, 's1@sai', ['一つ前']), ['一つ前'], '行が届いていれば二重にしない')
  assert.deepEqual(historyFrom(rows, 's1@sai', ['   ']), ['一つ前'], '空白だけは無視')
})

test('canGoBack / canGoForward: 空か、カーソルが 1 行目 / 最終行のときだけ', () => {
  assert.equal(canGoBack('', 0), true)
  assert.equal(canGoBack('一行だけ', 4), true)
  assert.equal(canGoBack('1行目\n2行目', 2), true, '1 行目にいる')
  assert.equal(canGoBack('1行目\n2行目', 6), false, '2 行目にいるので普通のカーソル移動')
  assert.equal(canGoForward('', 0), true)
  assert.equal(canGoForward('1行目\n2行目', 6), true, '最終行にいる')
  assert.equal(canGoForward('1行目\n2行目', 2), false)
})

test('stepHistory: ↑ で古い方へ、↓ で新しい方へ。最後まで戻ると打ちかけが返る', () => {
  const items = ['新しい', '真ん中', '古い']
  let state: HistoryState = { items, index: NOT_IN_HISTORY, draft: '' }

  const back1 = stepHistory(state, 'back', '打ちかけ')!
  assert.equal(back1.text, '新しい')
  assert.equal(back1.state.index, 0)
  assert.equal(back1.state.draft, '打ちかけ', '入るときの本文を覚える')
  state = back1.state

  const back2 = stepHistory(state, 'back', '新しい')!
  assert.equal(back2.text, '真ん中')
  assert.equal(back2.state.draft, '打ちかけ', '打ちかけは上書きしない')
  state = back2.state

  const back3 = stepHistory(state, 'back', '真ん中')!
  assert.equal(back3.text, '古い')
  state = back3.state
  assert.equal(stepHistory(state, 'back', '古い'), null, 'これ以上は古いものが無い')

  const fwd1 = stepHistory(state, 'forward', '古い')!
  assert.equal(fwd1.text, '真ん中')
  state = fwd1.state
  const fwd2 = stepHistory(state, 'forward', '真ん中')!
  assert.equal(fwd2.text, '新しい')
  state = fwd2.state
  const fwd3 = stepHistory(state, 'forward', '新しい')!
  assert.equal(fwd3.text, '打ちかけ', '一番新しいものから ↓ で打ちかけに戻る')
  assert.equal(fwd3.state.index, NOT_IN_HISTORY)
  assert.equal(stepHistory(fwd3.state, 'forward', '打ちかけ'), null, '履歴に入っていなければ ↓ は何もしない')
})

test('stepHistory: 履歴が空なら何もしない', () => {
  const empty = { items: [], index: NOT_IN_HISTORY, draft: '' }
  assert.equal(stepHistory(empty, 'back', 'x'), null)
  assert.equal(stepHistory(empty, 'forward', 'x'), null)
})
