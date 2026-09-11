import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentEntry, agentTargets, clipReply, deliveredText, isDeliveryOf, replyOf, sessionLabel } from './agentMessages.ts'
import type { FeedRow, SessionSummary } from './types.ts'

const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    project: 'o/r',
    agent: 'claude',
    session_source: 'payload',
    host: '',
    title: `${id} の題名`,
    branch: 'main',
    last_text: '',
    ...over,
  }) as SessionSummary

test('deliveredText / isDeliveryOf: 見出しの id で、そのメッセージで回ったターンかを見る（#310）', () => {
  const text = deliveredText({ label: '実装', project: 'o/r' }, 'abc123', '  テストを見て  ')
  assert.match(text, /^【SAI】#o\/r の「実装」からのメッセージです（id: abc123）/)
  assert.ok(text.endsWith('\n\nテストを見て'), '本文は前後の空白を落として見出しの後ろ')
  assert.equal(isDeliveryOf(text, 'abc123'), true)
  // record.py は user_text を 2000 字で切る。見出しは先頭にあるので、切れていても当たる
  assert.equal(isDeliveryOf(deliveredText({ label: 'x', project: 'o/r' }, 'abc123', 'あ'.repeat(5000)).slice(0, 2000), 'abc123'), true)
  assert.equal(isDeliveryOf(text, 'abc12'), false, '別の id（前方一致）には当たらない')
  assert.equal(isDeliveryOf('（id: abc123）人が打った', 'abc123'), false, '見出しの書き出しが無ければ人の入力')
  assert.equal(isDeliveryOf(undefined, 'abc123'), false)
})

test('replyOf: 相手のターン完了の行のうち、そのメッセージのものだけ', () => {
  const sent = deliveredText({ label: '実装', project: 'o/r' }, 'm1', '見て')
  const other = deliveredText({ label: '実装', project: 'o/r' }, 'm2', '別件')
  const rows = [
    { ts: '2026-09-11T01:00:00Z', session: 'B1', repo: 'r', event: 'UserPromptSubmit', user_text: sent, text: '' },
    { ts: '2026-09-11T01:01:00Z', session: 'B1', repo: 'r', event: 'PermissionRequest', user_text: sent, text: '許可待ち: Bash: ls' },
    { ts: '2026-09-11T01:02:00Z', session: 'C1', repo: 'r', event: 'Stop', user_text: sent, text: '別の相手' },
    { ts: '2026-09-11T01:03:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: other, text: '別のメッセージの返答' },
    { ts: '2026-09-11T01:04:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: sent, text: '見ました' },
  ] as FeedRow[]
  assert.equal(replyOf(rows, 'B1@r', 'm1')?.text, '見ました', '入力の行・待ちの行・別の相手・別の id は見ない')
  assert.equal(replyOf(rows, 'B1@r', 'm3'), null, 'まだ終わっていない')
})

test('clipReply: 長ければ切って、切ったことを書く（#311）', () => {
  assert.equal(clipReply('  短い  '), '短い')
  const long = clipReply('あ'.repeat(30), 10)
  assert.ok(long.startsWith('あ'.repeat(10)))
  assert.match(long, /あと 20 字を省略/)
})

test('agentTargets: 同じ project・自分以外・アーカイブ済みでない・返信できる相手だけ', () => {
  const from = session('A1@r')
  const sessions = [
    from,
    session('B1@r'),
    session('C1@r', { project: 'o/other' }),
    session('D1@r', { archived: true }),
    session('R1@r', { host: 'mini' }),
    session('S1@r', { session_source: 'synth' }),
  ]
  assert.deepEqual(agentTargets(sessions, from, 'testmac').map((s) => s.id), ['B1@r'])
  assert.deepEqual(agentTargets(sessions, session('A1@r', { project: '' }), 'testmac'), [], 'どのリポジトリか分からない送り元からは送れない')
})

test('agentEntry / sessionLabel: 呼び名は表示名 → 題名 → ID。最後の発言は 1 行目だけで、長ければ切る', () => {
  assert.equal(sessionLabel(session('A1@r', { meta: { name: 'レビュー' } })), 'レビュー')
  assert.equal(sessionLabel(session('A1@r')), 'A1@r の題名')
  assert.equal(sessionLabel(session('A1@r', { title: '' })), 'A1@r')
  const entry = agentEntry(session('B1@r', { last_text: `${'あ'.repeat(130)}\n二行目` }), true)
  assert.equal(entry.busy, true)
  assert.equal(entry.last_text, `${'あ'.repeat(120)}…`)
  assert.equal(agentEntry(session('B1@r', { last_text: '一行目\n二行目' }), false).last_text, '一行目')
})
