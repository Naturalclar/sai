import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedRow } from '../../shared/types.ts'
import { toUtterances } from './chatGroups.ts'
import { lastUtteranceKey } from './feedJump.ts'

const base = new Date('2026-09-02T03:00:00Z')
const at = (sec: number) => new Date(base.getTime() + sec * 1000).toISOString()

function row(sec: number, over: Partial<FeedRow> = {}): FeedRow {
  return { ts: at(sec), agent: 'claude', repo: 'sai', branch: 'main', session: 's1', session_source: 'payload', cwd: '/x', event: 'Stop', text: '返答', ...over }
}

/** key からバブルを引き戻す（テストの読みやすさのため） */
const utteranceOf = (rows: FeedRow[], key: string | null) => toUtterances(rows).find((u) => u.key === key)

test('lastUtteranceKey: そのセッションのエージェントの発言の一番新しいもの（自分の入力より後でも前でも）', () => {
  const rows = [
    row(0, { user_text: '1回目', text: '一つ目の返答' }),
    row(60, { session: 's2', text: '別のセッション' }),
    row(120, { user_text: '2回目', text: '二つ目の返答' }),
    row(180, { event: 'UserPromptSubmit', user_text: '3回目（まだ返答が無い）', text: '' }),
  ]
  const u = utteranceOf(rows, lastUtteranceKey(rows, 's1@sai'))
  assert.equal(u?.speaker, 'claude', '最後に自分が打っていても、セッションが最後に言ったことを出す')
  assert.equal(u?.text, '二つ目の返答')
})

test('lastUtteranceKey: 待ちの行もエージェントの発言として数える', () => {
  const rows = [row(0, { text: '返答' }), row(30, { event: 'PermissionRequest', text: '許可待ち: Bash: ls' })]
  assert.equal(utteranceOf(rows, lastUtteranceKey(rows, 's1@sai'))?.waiting, true)
})

test('lastUtteranceKey: 同じ秒の別のセッションには当たらない（ts ではなく key で指す）', () => {
  const rows = [row(0, { session: 's1', text: 'こちら' }), row(0, { session: 's2', text: '同じ秒の別のセッション' })]
  const a = lastUtteranceKey(rows, 's1@sai')
  const b = lastUtteranceKey(rows, 's2@sai')
  assert.notEqual(a, b)
  assert.equal(utteranceOf(rows, a)?.text, 'こちら')
  assert.equal(utteranceOf(rows, b)?.text, '同じ秒の別のセッション')
})

test('lastUtteranceKey: 1 行から出る自分の入力と返答（同じ ts）では、返答の方を指す', () => {
  const rows = [row(0, { user_text: '頼み', text: '返答' })]
  const u = utteranceOf(rows, lastUtteranceKey(rows, 's1@sai'))
  assert.equal(u?.speaker, 'claude')
})

test('lastUtteranceKey: エージェントの発言が無ければ自分の入力、何も無ければ null', () => {
  const onlyMine = [row(0, { event: 'UserPromptSubmit', user_text: '打っただけ', text: '' })]
  assert.equal(utteranceOf(onlyMine, lastUtteranceKey(onlyMine, 's1@sai'))?.speaker, 'me')
  assert.equal(lastUtteranceKey(onlyMine, 's2@sai'), null, 'フィードに居ないセッション（窓の外・絞り込み）')
  assert.equal(lastUtteranceKey([], 's1@sai'), null)
})

test('lastUtteranceKey: バブルにならない行（知らない event）は飛び先にしない', () => {
  const rows = [row(0, { text: '本物の返答' }), row(30, { event: 'SubagentStop', text: '' })]
  assert.equal(utteranceOf(rows, lastUtteranceKey(rows, 's1@sai'))?.text, '本物の返答')
})
