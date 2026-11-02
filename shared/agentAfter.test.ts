import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AFTER_END, AFTER_MARK, AFTER_MAX_CHARS, AFTER_PER_TARGET, afterTurns, askRefs, humanTurn, withAfterTurns } from './agentAfter.ts'
import type { AfterAsk, AfterClosed } from './agentAfter.ts'
import { HANDED_END, deliveredText, splitHandedReplies, withHandedReplies } from './agentMessages.ts'
import { loopPrompt } from './loops.ts'
import type { FeedRow } from './types.ts'

const ask = (over: Partial<AfterAsk> = {}): AfterAsk => ({ message_id: 'a1', to: 'B1@r', to_name: 'セッション B', text: '#900 に着手してください。\n前提は #700', ...over })
const delivered = (id: string, text = '#900 に着手してください。') => deliveredText({ label: 'セッション A', project: 'o/r' }, id, text)
const stop = (ts: string, user_text: string, text: string, session = 'B1'): FeedRow => ({ ts, session, repo: 'r', event: 'Stop', user_text, text }) as FeedRow
const opts = (closed: [number, AfterClosed][] = [], lines: Record<string, string> = {}) => ({
  lineOf: (_entity: string, row: FeedRow) => lines[row.ts] ?? '',
  closed: new Map(closed),
  ownIds: new Set(['a1', 'a2']),
})
// 返答（a1 のターン）のあと、相手で人が 2 ターン進めた
const base = [
  stop('2026-10-28T10:00:00+09:00', delivered('a1'), '着手しました。PR は #901'),
  stop('2026-10-28T11:00:00+09:00', '同じ PR で進めて', '同じ PR にまとめました\n詳しくは…'),
  stop('2026-10-28T12:00:00+09:00', 'テストも足して', 'テストを足しました'),
]

test('askRefs: 頼んだ番号は 1 行目の #N だけ（2 行目からの前提の番号は見ない）', () => {
  assert.deepEqual(askRefs('#900 に着手してください。\n前提は #700'), [900])
  assert.deepEqual(askRefs('PR #901 と #900 を見て'), [901, 900])
  assert.deepEqual(askRefs('調べてください\n#900'), [])
})

test('humanTurn: 人の入力だけ（メッセージ・ループの周・要約・空は人ではない）', () => {
  assert.equal(humanTurn('同じ PR で進めて'), true)
  assert.equal(humanTurn(delivered('zz')), false)
  assert.equal(humanTurn(loopPrompt({ goal: '直す', until: '緑', max_rounds: 5, deadline: '2026-10-28T20:00:00+09:00', interval_s: 60, round: 2, note: '' }, Date.parse('2026-10-28T10:00:00+09:00'))), false)
  assert.equal(humanTurn(''), false)
})

test('afterTurns: 返答のあと人が始めた 2 ターンを添え、覚えた位置より前は二度添えない', () => {
  const r = afterTurns([ask()], base, opts([], { '2026-10-28T11:00:00+09:00': '人の指示で同じ PR にまとめた' }))
  assert.ok(r.block.startsWith(AFTER_MARK) && r.block.endsWith(AFTER_END))
  assert.match(r.block, /「セッション B」（頼んだ件: #900）/)
  assert.match(r.block, /10\/28 11:00 人の指示で同じ PR にまとめた/, '一言があれば一言')
  assert.match(r.block, /10\/28 12:00 テストを足しました/, '一言が無ければ本文の頭の 1 行')
  assert.doesNotMatch(r.block, /着手しました/, '返答のターンそのものは添えない')
  assert.doesNotMatch(r.block, /詳しくは/, '本文の 2 行目からは添えない')
  assert.equal(r.turns, 2)
  assert.deepEqual(r.updates, [{ message_id: 'a1', after_at: '2026-10-28T12:00:00+09:00' }])
  // 次のターン: 位置を覚えたので同じ 2 行は添わない
  const again = afterTurns([ask({ after_at: '2026-10-28T12:00:00+09:00' })], base, opts())
  assert.equal(again.block, '')
  assert.deepEqual(again.updates, [])
})

test('afterTurns: 返答がまだなら添えない', () => {
  assert.equal(afterTurns([ask()], base.slice(1), opts()).block, '')
})

test('afterTurns: 送り元からのメッセージで起きたターンは添えない（返答と二重にしない）', () => {
  const rows = [...base, stop('2026-10-28T13:00:00+09:00', delivered('a2', '追加でこれも'), '追加分もやりました')]
  const r = afterTurns([ask()], rows, opts())
  assert.doesNotMatch(r.block, /追加分/)
  assert.equal(r.turns, 2)
})

test('afterTurns: 頼んだ PR がマージされたら、そこまでと「マージされました」を添えて終わる。閉じたあとに始まったターンは添えない', () => {
  const rows = [
    ...base,
    // 待ちで起きたターン（人ではない）の中でマージされた
    { ts: '2026-10-28T12:50:00+09:00', session: 'B1', repo: 'r', event: 'UserPromptSubmit', user_text: '（CI が終わったので起こした）', text: '' } as FeedRow,
    stop('2026-10-28T13:00:00+09:00', '', 'PR #901 をマージしました'),
    stop('2026-10-28T14:00:00+09:00', '次の件をお願い', '次の件に移りました'),
  ]
  const r = afterTurns([ask({ text: 'PR #901 をマージまで見てください' })], rows, opts([[901, { kind: 'pr', at: '2026-10-28T12:55:00+09:00' }]]))
  assert.match(r.block, /13:00（相手が自分で回したターン） PR #901 をマージしました/)
  assert.match(r.block, /#901 はマージされました（10\/28 12:55）。この件で添えるのはここまでです/)
  assert.doesNotMatch(r.block, /次の件/)
  assert.deepEqual(r.updates, [{ message_id: 'a1', after_at: '2026-10-28T13:00:00+09:00', done: true }])
})

test('afterTurns: 返答より前に閉じていた件は、何も添えずに終わりにする', () => {
  const r = afterTurns([ask()], base.slice(0, 1), opts([[900, { kind: 'issue', at: '2026-10-28T09:59:00+09:00' }]]))
  assert.equal(r.block, '')
  assert.deepEqual(r.updates, [{ message_id: 'a1', done: true }])
})

test('afterTurns: 相手ごとに直近 3 ターン。超えた分は「ほか N ターン」', () => {
  const many = [base[0]!, ...Array.from({ length: 5 }, (_, i) => stop(`2026-10-28T1${i + 1}:30:00+09:00`, `指示 ${i}`, `進めた ${i}`))]
  const r = afterTurns([ask()], many, opts())
  assert.equal((r.block.match(/^- 10\/28/gm) ?? []).length, AFTER_PER_TARGET)
  assert.match(r.block, /進めた 4/)
  assert.doesNotMatch(r.block, /進めた 1/)
  assert.match(r.block, /- ほか 2 ターン/)
  assert.equal(r.turns, 5)
  assert.equal(splitHandedReplies(withAfterTurns('人の本文', r.block)).after, 5)
})

test('afterTurns: 全体で 1,000 字を超えた分は数だけ', () => {
  const long = 'あ'.repeat(400)
  const rows = [
    base[0]!,
    stop('2026-10-28T11:00:00+09:00', '指示', '一'),
    stop('2026-10-28T12:00:00+09:00', '指示', '二'),
    stop('2026-10-28T10:00:00+09:00', delivered('a3'), '返答', 'C1'),
    stop('2026-10-28T11:30:00+09:00', '指示', '三', 'C1'),
  ]
  const lines = Object.fromEntries(['2026-10-28T11:00:00+09:00', '2026-10-28T12:00:00+09:00', '2026-10-28T11:30:00+09:00'].map((ts) => [ts, long]))
  const r = afterTurns([ask(), ask({ message_id: 'a3', to: 'C1@r', to_name: 'セッション C' })], rows, opts([], lines))
  const shown = r.block.split('\n').filter((l) => /^- 10\/28/.test(l))
  assert.ok(shown.join('').length <= AFTER_MAX_CHARS)
  assert.equal(shown.length, 2)
  assert.match(r.block, /「セッション C」[^]*- ほか 1 ターン/)
})

test('afterTurns: 同じ相手への頼みが 2 つでも、同じターンは 1 回だけ', () => {
  const rows = [base[0]!, stop('2026-10-28T10:30:00+09:00', delivered('a2', '#902 も'), '#902 も見ます'), ...base.slice(1)]
  const r = afterTurns([ask(), ask({ message_id: 'a2', text: '#902 も' })], rows, opts())
  assert.equal((r.block.match(/テストを足しました/g) ?? []).length, 1)
  assert.match(r.block, /頼んだ件: #900、#902/)
})

test('splitHandedReplies: 返答の塊が先、その後の塊、人の本文の順に足し、画面には人の本文だけ出す', () => {
  const r = afterTurns([ask()], base, opts())
  const body = withHandedReplies(withAfterTurns('人の本文', r.block), [{ message_id: 'a9', to_name: 'セッション C', status: 'done', text: '返答' }])
  assert.ok(body.indexOf(HANDED_END) < body.indexOf(AFTER_MARK), '返答が先')
  assert.deepEqual(splitHandedReplies(body), { text: '人の本文', handed: 1, after: 2 })
  assert.deepEqual(splitHandedReplies(withAfterTurns('人の本文', r.block)), { text: '人の本文', handed: 0, after: 2 })
})
