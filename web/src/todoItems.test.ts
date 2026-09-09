import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Approval, ApprovalMap, ReplyingMap, SessionSummary } from '../../shared/types.ts'
import { todoItems } from './todoItems.ts'

function summary(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: 's1@sai',
    start: '2026-09-02T10:00:00+09:00',
    end: '2026-09-02T10:10:00+09:00',
    date: '2026-09-02',
    dates: ['2026-09-02'],
    agent: 'claude',
    agents: ['claude'],
    repo: 'sai',
    repos: ['sai'],
    project: 'Naturalclar/sai',
    projects: ['Naturalclar/sai'],
    remote: '',
    branch: 'main',
    branches: ['main'],
    cwd: '/tmp/sai',
    turns: 2,
    title: 'タイトル',
    title_full: 'タイトル',
    session_source: 'payload',
    sources: ['payload'],
    last_text: '返答',
    model: '',
    models: [],
    permission_mode: '',
    waiting: '',
    pane: '',
    pid: 0,
    last_turn: '',
    ...over,
  }
}

function approval(over: Partial<Approval>): Approval {
  return {
    approval_id: 'a1',
    id: 's1@sai',
    since: '2026-09-02T10:05:00+09:00',
    tool_name: 'Bash',
    input: { command: 'ls' },
    tool_use_id: 't1',
    text: '許可待ち: Bash: ls',
    ...over,
  }
}

test('todoItems: 答え待ちは answer、行から見た待ちは watch。待たせている順', () => {
  const sessions = [
    summary({ id: 'a@sai', end: '2026-09-02T10:30:00+09:00', waiting: '許可待ち: Edit: x.ts' }),
    summary({ id: 'b@sai', end: '2026-09-02T10:20:00+09:00' }), // 待っていない
    summary({ id: 'c@sai', end: '2026-09-02T10:40:00+09:00' }),
  ]
  const approvals: ApprovalMap = { 'c@sai': [approval({ id: 'c@sai', since: '2026-09-02T10:00:00+09:00', text: '質問: どれ?' })] }
  const items = todoItems(sessions, approvals)
  assert.deepEqual(
    items.map((t) => [t.id, t.kind, t.text, t.since]),
    [
      ['c@sai', 'answer', '質問: どれ?', '2026-09-02T10:00:00+09:00'],
      ['a@sai', 'watch', '許可待ち: Edit: x.ts', '2026-09-02T10:30:00+09:00'],
    ],
  )
  assert.equal(items[0]!.session?.id, 'c@sai')
  assert.equal(items[0]!.approval?.approval_id, 'a1')
  assert.equal(items[1]!.approval, null)
})

test('todoItems: 答え待ちは絞り込みで一覧から消えていても出す（session は null）', () => {
  // approvals はサーバの Approvals.snapshot() そのもので、絞り込みを通っていない。
  // エージェントを止めているものなので、一覧に居なくても取りこぼさない
  const items = todoItems([], { 'x@other': [approval({ id: 'x@other' })] })
  assert.equal(items.length, 1)
  assert.equal(items[0]!.id, 'x@other')
  assert.equal(items[0]!.session, null)
  assert.equal(items[0]!.kind, 'answer')
})

test('todoItems: 同じセッションに両方あれば answer だけ（二重に出さない）', () => {
  const items = todoItems([summary({ id: 's1@sai', waiting: '許可待ち: Bash: ls' })], { 's1@sai': [approval({})] })
  assert.deepEqual(items.map((t) => t.kind), ['answer'])
})

test('todoItems: 待っていないセッションとアーカイブ済みは出さない', () => {
  assert.deepEqual(todoItems([summary({ id: 's1@sai' })], {}), [])
  assert.deepEqual(todoItems([summary({ id: 's1@sai', waiting: '許可待ち', archived: true })], {}), [])
  // アーカイブ済みでも答え待ちなら出す（プロセスが止まっているのは変わらない）
  assert.equal(todoItems([summary({ id: 's1@sai', archived: true })], { 's1@sai': [approval({})] }).length, 1)
})

test('todoItems: 同時刻は ID で決めて、ポーリングのたびに並びが揺れない', () => {
  const at = '2026-09-02T10:00:00+09:00'
  const sessions = [summary({ id: 'b@sai', end: at, waiting: 'w' }), summary({ id: 'a@sai', end: at, waiting: 'w' })]
  assert.deepEqual(todoItems(sessions, {}).map((t) => t.id), ['a@sai', 'b@sai'])
  assert.deepEqual(todoItems([...sessions].reverse(), {}).map((t) => t.id), ['a@sai', 'b@sai'])
})

test('todoItems: 空の approvals の配列は無視する', () => {
  assert.deepEqual(todoItems([summary({ id: 's1@sai' })], { 's1@sai': [] }), [])
})

// ---- #232: 別プロセスの返信を処理中なら「待っている」ではなく「動いている」

test('todoItems: 別プロセスの返信を処理中のセッションは watch を出さない', () => {
  // 行の waiting は「待ちの行のあとターン完了が来るまで」消えない。許可や質問に答えても
  // 再開の行は書かれないので、答えたあとも要対応に残ってしまっていた（#232）。
  // -p の許可・質問は必ず approvals に載るので、載っていなければ待っていない
  const sessions = [summary({ id: 's1@sai', waiting: '質問: opencode を入れていい?' })]
  const replying: ReplyingMap = { 's1@sai': { since: '2026-09-02T10:11:00+09:00', text: '209に着手して' } }
  assert.deepEqual(todoItems(sessions, {}, replying), [], '動いている間は出さない')

  // 本当に答えを待っているなら approvals に載るので、そちらで出る（答えられる方）
  const withAsk = todoItems(sessions, { 's1@sai': [approval({ text: '質問: どれ?' })] }, replying)
  assert.deepEqual(withAsk.map((t) => t.kind), ['answer'])
})

test('todoItems: 端末に打ち込んだ返信（via: terminal）の処理中は watch を残す', () => {
  // 端末のセッションには SAI から答える口が無く、行の waiting だけが手がかりなので消してはいけない
  const sessions = [summary({ id: 's1@sai', waiting: '許可待ち: Bash: rm -rf x' })]
  const replying: ReplyingMap = { 's1@sai': { since: '2026-09-02T10:11:00+09:00', text: '続けて', via: 'terminal' } }
  assert.deepEqual(todoItems(sessions, {}, replying).map((t) => t.kind), ['watch'])
})

test('todoItems: 失敗して残っている replying は「動いている」ではないので watch を出す', () => {
  const sessions = [summary({ id: 's1@sai', waiting: '許可待ち: Bash: ls' })]
  const replying: ReplyingMap = { 's1@sai': { since: '2026-09-02T10:11:00+09:00', text: 'x', failed: { code: 1, tail: 'boom' } } }
  assert.deepEqual(todoItems(sessions, {}, replying).map((t) => t.kind), ['watch'])
})

test('todoItems: replying を渡さなくても今までどおり（既定は空）', () => {
  const sessions = [summary({ id: 's1@sai', waiting: '許可待ち: Bash: ls' })]
  assert.deepEqual(todoItems(sessions, {}).map((t) => t.kind), ['watch'])
})

// ---- #232: 「SAI からは答えられない」と決めつけない

test('todoItems: watch の replyable は、その会話に返信欄から打てるかで決まる', () => {
  const canReply = todoItems([summary({ id: 's1@sai', waiting: '許可待ち: Bash: ls' })], {})
  assert.equal(canReply[0]!.replyable, true, '普通のセッションは開いて返信欄から答えられる')

  // 合成 ID・出どころ不明は再開できない（shared/reply.ts の replyBlockedReason）ので、端末で答えるしかない
  const synth = todoItems([summary({ id: 's1@sai', waiting: 'w', session_source: 'synth', sources: ['synth'] })], {})
  assert.equal(synth[0]!.replyable, false)
  const unknownId = todoItems([summary({ id: 'unknown-2026-09-02@sai', waiting: 'w' })], {})
  assert.equal(unknownId[0]!.replyable, false)
  const codexTui = todoItems([summary({ id: 's1@sai', waiting: 'w', agent: 'unknown', agents: ['unknown'] })], {})
  assert.equal(codexTui[0]!.replyable, false, 'エージェントが分からなければ再開できない')
})

test('todoItems: answer の replyable は使わないので false のまま', () => {
  const items = todoItems([summary({ id: 's1@sai' })], { 's1@sai': [approval({})] })
  assert.equal(items[0]!.replyable, false)
})
