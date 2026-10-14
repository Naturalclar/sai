import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Approval, ApprovalMap, Loop, LoopMap, ReplyingMap, SessionSummary, Wait } from './types.ts'
import { awaitsNext, doneItems, pendingItems, TERMINAL_STUCK_TEXT, todoItems, todoKey, todoSections } from './todoItems.ts'
import { TERMINAL_UNKNOWN_PAUSED } from './agentMessages.ts'

/** このサーバが動いているマシン（#114）。行の host が違えば「別のマシン」 */
const SELF = 'mac'

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
    host: '',
    hosts: [],
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
    idle: '',
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
  const items = todoItems(sessions, approvals, SELF)
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
  const items = todoItems([], { 'x@other': [approval({ id: 'x@other' })] }, SELF)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.id, 'x@other')
  assert.equal(items[0]!.session, null)
  assert.equal(items[0]!.kind, 'answer')
})

test('todoItems: 同じセッションに両方あれば answer だけ（二重に出さない）', () => {
  const items = todoItems([summary({ id: 's1@sai', waiting: '許可待ち: Bash: ls' })], { 's1@sai': [approval({})] }, SELF)
  assert.deepEqual(items.map((t) => t.kind), ['answer'])
})

test('todoItems: 待っていないセッションとアーカイブ済みは出さない', () => {
  assert.deepEqual(todoItems([summary({ id: 's1@sai' })], {}, SELF), [])
  assert.deepEqual(todoItems([summary({ id: 's1@sai', waiting: '許可待ち', archived: true })], {}, SELF), [])
  // アーカイブ済みでも答え待ちなら出す（プロセスが止まっているのは変わらない）
  assert.equal(todoItems([summary({ id: 's1@sai', archived: true })], { 's1@sai': [approval({})] }, SELF).length, 1)
})

test('todoItems: 同時刻は ID で決めて、ポーリングのたびに並びが揺れない', () => {
  const at = '2026-09-02T10:00:00+09:00'
  const sessions = [summary({ id: 'b@sai', end: at, waiting: 'w' }), summary({ id: 'a@sai', end: at, waiting: 'w' })]
  assert.deepEqual(todoItems(sessions, {}, SELF).map((t) => t.id), ['a@sai', 'b@sai'])
  assert.deepEqual(todoItems([...sessions].reverse(), {}, SELF).map((t) => t.id), ['a@sai', 'b@sai'])
})

test('todoItems: 空の approvals の配列は無視する', () => {
  assert.deepEqual(todoItems([summary({ id: 's1@sai' })], { 's1@sai': [] }, SELF), [])
})

// ---- #232: 別プロセスの返信を処理中なら「待っている」ではなく「動いている」

test('todoItems: 別プロセスの返信を処理中のセッションは watch を出さない', () => {
  // 行の waiting は「待ちの行のあとターン完了が来るまで」消えない。許可や質問に答えても
  // 再開の行は書かれないので、答えたあとも要対応に残ってしまっていた（#232）。
  // -p の許可・質問は必ず approvals に載るので、載っていなければ待っていない
  const sessions = [summary({ id: 's1@sai', waiting: '質問: opencode を入れていい?' })]
  const replying: ReplyingMap = { 's1@sai': { since: '2026-09-02T10:11:00+09:00', text: '209に着手して' } }
  assert.deepEqual(todoItems(sessions, {}, SELF, replying), [], '動いている間は出さない')

  // 本当に答えを待っているなら approvals に載るので、そちらで出る（答えられる方）
  const withAsk = todoItems(sessions, { 's1@sai': [approval({ text: '質問: どれ?' })] }, SELF, replying)
  assert.deepEqual(withAsk.map((t) => t.kind), ['answer'])
})

test('todoItems: 端末に打ち込んだ返信（via: terminal）の処理中は watch を残す', () => {
  // 端末のセッションには SAI から答える口が無く、行の waiting だけが手がかりなので消してはいけない
  const sessions = [summary({ id: 's1@sai', waiting: '許可待ち: Bash: rm -rf x' })]
  const replying: ReplyingMap = { 's1@sai': { since: '2026-09-02T10:11:00+09:00', text: '続けて', via: 'terminal' } }
  assert.deepEqual(todoItems(sessions, {}, SELF, replying).map((t) => t.kind), ['watch'])
})

test('todoItems: 失敗して残っている replying は「動いている」ではないので watch を出す', () => {
  const sessions = [summary({ id: 's1@sai', waiting: '許可待ち: Bash: ls' })]
  const replying: ReplyingMap = { 's1@sai': { since: '2026-09-02T10:11:00+09:00', text: 'x', failed: { code: 1, tail: 'boom' } } }
  assert.deepEqual(todoItems(sessions, {}, SELF, replying).map((t) => t.kind), ['watch'])
})

test('todoItems: replying を渡さなくても今までどおり（既定は空）', () => {
  const sessions = [summary({ id: 's1@sai', waiting: '許可待ち: Bash: ls' })]
  assert.deepEqual(todoItems(sessions, {}, SELF).map((t) => t.kind), ['watch'])
})

// ---- #232: 「SAI からは答えられない」と決めつけない

test('todoItems: watch の replyable は、その会話に返信欄から打てるかで決まる', () => {
  const canReply = todoItems([summary({ id: 's1@sai', waiting: '許可待ち: Bash: ls' })], {}, SELF)
  assert.equal(canReply[0]!.replyable, true, '普通のセッションは開いて返信欄から答えられる')

  // 合成 ID・出どころ不明は再開できない（shared/reply.ts の replyBlockedReason）ので、端末で答えるしかない
  const synth = todoItems([summary({ id: 's1@sai', waiting: 'w', session_source: 'synth', sources: ['synth'] })], {}, SELF)
  assert.equal(synth[0]!.replyable, false)
  const unknownId = todoItems([summary({ id: 'unknown-2026-09-02@sai', waiting: 'w' })], {}, SELF)
  assert.equal(unknownId[0]!.replyable, false)
  const codexTui = todoItems([summary({ id: 's1@sai', waiting: 'w', agent: 'unknown', agents: ['unknown'] })], {}, SELF)
  assert.equal(codexTui[0]!.replyable, false, 'エージェントが分からなければ再開できない')
})

test('todoItems: OpenCode の待ちは「端末で答えて」に倒す（#421。返信欄からは許可を解けない）', () => {
  // OpenCode の待ちは必ず許可待ちで、返信を送っても保留は解けない。SAI が起こしたサーバの分は
  // approvals（answer）として上に出るので、watch に残るのは端末の TUI か別のサーバの分＝触れないもの
  const oc = todoItems([summary({ id: 'ses_1@r', waiting: '許可待ち: external_directory: /etc/hosts', agent: 'opencode', agents: ['opencode'] })], {}, SELF)
  assert.equal(oc.length, 1, '待っていることは出す')
  assert.equal(oc[0]!.replyable, false)
  // Claude / Codex は今までどおり（返信欄から打てるなら true）
  assert.equal(todoItems([summary({ id: 's1@sai', waiting: 'w', agent: 'codex', agents: ['codex'] })], {}, SELF)[0]!.replyable, true)
})

test('todoItems: 別のマシンのセッションは出すが、ここからは答えられない（#114）', () => {
  // 待っていることに変わりはないので項目としては出す（あちらのマシンへ行けば答えられる）
  const remote = todoItems([summary({ id: 's1@sai', waiting: '許可待ち: Bash: ls', host: 'mini', hosts: ['mini'] })], {}, SELF)
  assert.equal(remote.length, 1)
  assert.equal(remote[0]!.replyable, false)
  // 同じマシンの行と、host を載せない古い行は今までどおり
  assert.equal(todoItems([summary({ id: 's1@sai', waiting: 'w', host: 'mac', hosts: ['mac'] })], {}, SELF)[0]!.replyable, true)
  assert.equal(todoItems([summary({ id: 's1@sai', waiting: 'w' })], {}, SELF)[0]!.replyable, true)
})

test('todoItems: answer の replyable は使わないので false のまま', () => {
  const items = todoItems([summary({ id: 's1@sai' })], { 's1@sai': [approval({})] }, SELF)
  assert.equal(items[0]!.replyable, false)
})

test('todoItems: 終わって次を待っているだけのセッションは done。watch には出ない（#438）', () => {
  const items = todoItems([summary({ id: 's1@sai', idle: '入力待ち' })], {}, SELF)
  assert.deepEqual(
    items.map((t) => [t.kind, t.text]),
    [['done', '入力待ち']],
  )
  assert.equal(pendingItems(items).length, 0, 'バッジ・タブの題名・通知には数えない')
  assert.deepEqual(doneItems(items).map((t) => t.id), ['s1@sai'])
})

test('todoItems: 本当の待ちと「終わって次を待っている」が混ざっても、数えるのは待ちだけ（#438）', () => {
  const sessions = [
    summary({ id: 'a@sai', end: '2026-09-02T10:10:00+09:00', idle: '入力待ち' }),
    summary({ id: 'b@sai', end: '2026-09-02T10:20:00+09:00', waiting: '許可待ち: Bash: ls' }),
  ]
  const items = todoItems(sessions, {}, SELF)
  assert.deepEqual(
    items.map((t) => t.kind),
    ['done', 'watch'],
    '並びは待たせている順のまま（画面が上下の段に分ける）',
  )
  assert.deepEqual(pendingItems(items).map((t) => t.id), ['b@sai'])
})

test('todoItems: 答え待ちが出ているセッションでは done を出さない（#438）', () => {
  const items = todoItems([summary({ id: 's1@sai', idle: '入力待ち' })], { 's1@sai': [approval({})] }, SELF)
  assert.deepEqual(
    items.map((t) => t.kind),
    ['answer'],
  )
})

test('todoItems: アーカイブ済みと、別プロセスの返信を処理中は done にも出さない（#438）', () => {
  assert.deepEqual(todoItems([summary({ id: 's1@sai', idle: '入力待ち', archived: true })], {}, SELF), [])
  // via 省略 = 別プロセス（`-p`）
  const running: ReplyingMap = { 's1@sai': { text: '次', since: '2026-09-02T10:11:00+09:00' } }
  assert.deepEqual(todoItems([summary({ id: 's1@sai', idle: '入力待ち' })], {}, SELF, running), [])
})

test('todoItems: done でも返信欄から次を送れるかは watch と同じ判定（#438）', () => {
  const [mine] = todoItems([summary({ id: 's1@sai', idle: '入力待ち', host: SELF })], {}, SELF)
  assert.equal(mine!.replyable, true)
  const [remote] = todoItems([summary({ id: 's1@sai', idle: '入力待ち', host: 'other' })], {}, SELF)
  assert.equal(remote!.replyable, false, '別のマシンのセッションには送れない（#114）')
})

// ---- ターンが終わって次の指示を待っている（#513） ----

const END = '2026-09-02T10:10:00+09:00'

test('todoItems: 最後の行がターン完了なら、入力待ちが鳴っていなくても done（#513。-p・Codex・OpenCode は鳴らさない）', () => {
  const items = todoItems([summary({ id: 's1@sai', end: END, last_turn_ts: END, last_kind: 'turn', last_text: 'PR を出しました' })], {}, SELF)
  assert.deepEqual(
    items.map((t) => [t.kind, t.text, t.since]),
    [['done', 'PR を出しました', END]],
  )
  assert.equal(pendingItems(items).length, 0, 'バッジ・タブの題名・通知には数えない（#438 のまま）')
  for (const agent of ['codex', 'opencode'] as const) {
    assert.deepEqual(todoItems([summary({ agent, end: END, last_turn_ts: END, last_kind: 'turn' })], {}, SELF).map((t) => t.kind), ['done'], agent)
  }
})

test('todoItems: 文言は一言があればそれ、無ければ最後の発言、どちらも無ければ（本文なし）', () => {
  const at = { end: END, last_turn_ts: END, last_kind: 'turn' as const }
  assert.equal(todoItems([summary({ ...at, last_summary: 'PR 出したよ', last_text: '長い本文' })], {}, SELF)[0]!.text, 'PR 出したよ')
  assert.equal(todoItems([summary({ ...at, last_text: '' })], {}, SELF)[0]!.text, '（本文なし）')
  // 一言が 2 つで組まれていれば（#713）、「人が次にすること」が行の文言で、「何が起きたか」は後ろに小さく添える
  const two = todoItems([summary({ ...at, last_summary: 'PR 出したよ！', last_summary_next: 'よければ「マージして」と言ってください。', last_text: '長い本文' })], {}, SELF)[0]!
  assert.deepEqual([two.text, two.sub], ['よければ「マージして」と言ってください。', 'PR 出したよ！'])
  assert.equal(todoItems([summary({ ...at, last_summary: 'PR 出したよ', last_text: '長い本文' })], {}, SELF)[0]!.sub, undefined, '分かれていない一言は今までどおり 1 つ')
  const idle = todoItems([summary({ ...at, last_kind: 'idle', idle: '入力待ち', last_summary: 'PR 出したよ！', last_summary_next: '確認してください。' })], {}, SELF)[0]!
  assert.deepEqual([idle.text, idle.sub], ['入力待ち', undefined], '入力待ちの行は文言を変えない')
  assert.equal(todoItems([summary({ ...at, last_summary_next: '確認してください。', last_text: '長い本文' })], {}, SELF)[0]!.text, '長い本文', '一言が無ければ「人が次にすること」だけでは出さない')
  assert.equal(todoItems([summary({ ...at, last_text: 'PR [#374](https://github.com/o/r/pull/374) を出した' })], {}, SELF)[0]!.text, 'PR #374 を出した', 'Markdown の記号は落とす')
})

test('todoItems: ターン完了のあとに次の入力・終了・待ちが来ていれば done にしない（#513）', () => {
  const after = '2026-09-02T10:12:00+09:00'
  // 次の入力（UserPromptSubmit）が来ている＝ターンが回っている。/clear の SessionEnd も最後の行が変わる
  assert.deepEqual(todoItems([summary({ end: after, last_turn_ts: END, last_kind: 'resume' })], {}, SELF), [])
  assert.deepEqual(todoItems([summary({ end: after, last_turn_ts: END, last_kind: 'end' })], {}, SELF), [])
  // ターンが 1 回も終わっていない
  assert.deepEqual(todoItems([summary({ end: END, last_turn_ts: '', last_kind: 'resume' })], {}, SELF), [])
  // 待ちの行が後ろにあれば watch の方
  assert.deepEqual(todoItems([summary({ end: after, last_turn_ts: END, last_kind: 'waiting', waiting: '許可待ち: Bash: ls' })], {}, SELF).map((t) => t.kind), ['watch'])
})

test('todoItems: ターン完了と同じ秒に次の入力や /clear が届いても done にしない（行の ts は秒まで。#517 のレビュー）', () => {
  // end と last_turn_ts が同じ秒でも、最後の行が入力・終了なら終わって待っているのではない
  assert.deepEqual(todoItems([summary({ end: END, last_turn_ts: END, last_kind: 'resume' })], {}, SELF), [])
  assert.deepEqual(todoItems([summary({ end: END, last_turn_ts: END, last_kind: 'end' })], {}, SELF), [])
})

test('todoItems: 返信が処理中なら、端末に打ち込んだものでも done にしない（ターンが回っている。#513）', () => {
  const s = summary({ end: END, last_turn_ts: END, last_kind: 'turn' as const })
  const terminal: ReplyingMap = { 's1@sai': { text: '次', since: '2026-09-02T10:11:00+09:00', via: 'terminal' } }
  assert.deepEqual(todoItems([s], {}, SELF, terminal), [])
  const failed: ReplyingMap = { 's1@sai': { text: '次', since: '2026-09-02T10:11:00+09:00', failed: { code: 1, tail: 'x' } } }
  assert.deepEqual(todoItems([s], {}, SELF, failed).map((t) => t.kind), ['done'], '失敗して残っているものは「動いている」ではない')
})

test('todoItems: ループ（#634）が次の周を待っている間は done にしない。終わった・止まった・一時停止なら出す', () => {
  const s = summary({ end: END, last_turn_ts: END, last_kind: 'turn' as const })
  const loop = (status: Loop['status']): LoopMap => ({ 's1@sai': { goal: 'g', until: 'u', max_rounds: 10, deadline: END, interval_s: 600, status, round: 2, since: END } })
  assert.deepEqual(todoItems([s], {}, SELF, {}, loop('running')), [])
  for (const status of ['paused', 'done', 'gave_up', 'stopped'] as const) assert.deepEqual(todoItems([s], {}, SELF, {}, loop(status)).map((t) => t.kind), ['done'], status)
  // 待ち（watch）はループ中でも出す
  assert.deepEqual(todoItems([summary({ end: END, last_kind: 'waiting', waiting: '許可待ち: Bash: ls' })], {}, SELF, {}, loop('running')).map((t) => t.kind), ['watch'])
})

test('todoItems: done は終わった時刻の古い順（待たせている順）', () => {
  const items = todoItems(
    [
      summary({ id: 'new@sai', end: '2026-09-02T12:00:00+09:00', last_turn_ts: '2026-09-02T12:00:00+09:00', last_kind: 'turn' }),
      summary({ id: 'old@sai', end: '2026-09-01T09:00:00+09:00', last_turn_ts: '2026-09-01T09:00:00+09:00', last_kind: 'turn' }),
    ],
    {},
    SELF,
  )
  assert.deepEqual(items.map((t) => t.id), ['old@sai', 'new@sai'])
})

test('awaitsNext: 入力待ちか、最後の行がターン完了', () => {
  assert.equal(awaitsNext({ idle: '入力待ち', last_kind: 'idle' }), true)
  assert.equal(awaitsNext({ idle: '', last_kind: 'turn' }), true)
  for (const k of ['resume', 'end', 'waiting', 'other'] as const) assert.equal(awaitsNext({ idle: '', last_kind: k }), false, k)
  assert.equal(awaitsNext({ idle: '' }), false, '分からなければ出さない')
})

// ---- #551: 未読のあるセッションを答え待ちの次に

test('todoSections: 答え待ち → 未読（待機中も終了も）→ 待機中 → 終了。段の中は待たせている順のまま', () => {
  const sessions = [
    summary({ id: 'w-old@sai', end: '2026-09-02T10:01:00+09:00', waiting: '許可待ち: Bash: ls' }),
    summary({ id: 'w-unread@sai', end: '2026-09-02T10:05:00+09:00', waiting: '許可待ち: Bash: ls', unread: 1 }),
    summary({ id: 'd-old@sai', last_kind: 'turn', last_turn_ts: '2026-09-02T10:00:00+09:00' }),
    summary({ id: 'd-unread@sai', last_kind: 'turn', last_turn_ts: '2026-09-02T10:02:00+09:00', unread: 3 }),
    // 答え待ちは未読があっても一番上（未読の段には入れない）
    summary({ id: 'a@sai', end: '2026-09-02T10:09:00+09:00', unread: 2 }),
  ]
  const approvals: ApprovalMap = { 'a@sai': [approval({ id: 'a@sai', since: '2026-09-02T10:09:00+09:00' })] }
  const items = todoItems(sessions, approvals, SELF)
  const s = todoSections(items)
  assert.deepEqual(s.answer.map((t) => t.id), ['a@sai'])
  assert.deepEqual(s.unread.map((t) => [t.id, t.kind]), [
    ['d-unread@sai', 'done'],
    ['w-unread@sai', 'watch'],
  ])
  assert.deepEqual(s.watch.map((t) => t.id), ['w-old@sai'])
  assert.deepEqual(s.done.map((t) => t.id), ['d-old@sai'])
  // 並びを変えるだけで、数えるぶんは変えない（未読の終了をバッジ・通知に数えない）
  assert.deepEqual(pendingItems(items).map((t) => t.id), ['w-old@sai', 'w-unread@sai', 'a@sai'])
})

test('todoSections: 未読が 0 なら今までの段のまま', () => {
  const items = todoItems(
    [summary({ id: 'w@sai', waiting: '許可待ち', unread: 0 }), summary({ id: 'd@sai', last_kind: 'turn', last_turn_ts: END })],
    {},
    SELF,
  )
  const s = todoSections(items)
  assert.deepEqual([s.unread.length, s.watch.length, s.done.length], [0, 1, 1])
})

// ---- #732: 終わったのに自動では起こさない待ち

function wait(over: Partial<Wait>): Wait {
  return { id: 'w1', repo: 'owner-a/repo-a', pr: 12, then: '結果を読んで報告する', status: 'ready', result: 'success', late: true, since: '2026-09-02T09:00:00+09:00', deadline: '2026-09-02T11:00:00+09:00', finished_at: '2026-09-02T10:15:00+09:00', ...over }
}

test('todoItems: 終わったのに自動では起こさない待ち（late）は wait の行になり、数える。1 つの待ち = 1 行', () => {
  const sessions = [summary({ id: 'a@sai', last_kind: 'turn', last_turn_ts: '2026-09-02T09:01:00+09:00' })]
  const items = todoItems(sessions, {}, SELF, {}, {}, { 'a@sai': [wait({}), wait({ id: 'w2', pr: 13, result: 'failure', finished_at: '2026-09-02T10:20:00+09:00' })] })
  assert.deepEqual(
    items.map((t) => [t.id, t.kind, t.text, t.since, t.wait?.id]),
    [
      ['a@sai', 'done', '返答', '2026-09-02T09:01:00+09:00', undefined],
      ['a@sai', 'wait', 'PR #12 の CI は終わっています（CI は全部通りました）', '2026-09-02T10:15:00+09:00', 'w1'],
      ['a@sai', 'wait', 'PR #13 の CI は終わっています（CI が落ちました）', '2026-09-02T10:20:00+09:00', 'w2'],
    ],
  )
  // 数えるのは pendingItems() の 1 つ（バッジ・題名・通知）。終わって次を待っているだけの行は今までどおり数えない
  assert.deepEqual(pendingItems(items).map((t) => t.wait?.id), ['w1', 'w2'])
  // 行の鍵は待ちごとに違う（同じセッションに並んでもぶつからない）
  assert.equal(new Set(items.map(todoKey)).size, 3)
  // 行の返信欄は出さない（押すのは「いま起こす」「片付ける」）
  assert.ok(items.filter((t) => t.kind === 'wait').every((t) => !t.replyable && t.session?.id === 'a@sai'))
})

test('todoItems: SAI がまた見に行く待ち（確かめている・枠や処理中で起こせていない・起こしている）と、終わった待ち（諦めた・起こせなかった）は行にしない', () => {
  const list: Wait[] = [
    wait({ id: 'waiting', status: 'waiting', result: undefined, late: undefined }),
    wait({ id: 'held', late: undefined, reason: 'セッションが処理中です（終わったら起こします）' }),
    wait({ id: 'waking', status: 'waking' }),
    wait({ id: 'expired', status: 'expired', late: undefined }),
    wait({ id: 'halted', status: 'halted' }),
  ]
  assert.deepEqual(todoItems([summary({ id: 'a@sai' })], {}, SELF, {}, {}, { 'a@sai': list }), [])
  // 待ちを渡さない呼び方（古いサーバの応答）でも今までどおり
  assert.deepEqual(todoItems([summary({ id: 'a@sai' })], {}, SELF), [])
})

test('todoItems: wait は絞り込みで一覧から消えたセッションの分も出す（session は null）。答え待ち・アーカイブ済みのセッションでも出す', () => {
  const sessions = [summary({ id: 'a@sai', archived: true }), summary({ id: 'c@sai' })]
  const approvals: ApprovalMap = { 'c@sai': [approval({ id: 'c@sai', since: '2026-09-02T10:00:00+09:00' })] }
  const items = todoItems(sessions, approvals, SELF, {}, {}, { 'a@sai': [wait({})], 'gone@sai': [wait({ id: 'w3' })], 'c@sai': [wait({ id: 'w4' })] })
  assert.deepEqual(
    items.map((t) => [t.id, t.kind, t.session?.id ?? null]),
    [
      ['c@sai', 'answer', 'c@sai'],
      ['a@sai', 'wait', 'a@sai'],
      ['c@sai', 'wait', 'c@sai'],
      ['gone@sai', 'wait', null],
    ],
  )
  // 終わった時刻が出ない応答では、預かった時刻で並べる
  assert.equal(todoItems([], {}, SELF, {}, {}, { 'a@sai': [wait({ finished_at: undefined })] })[0]!.since, '2026-09-02T09:00:00+09:00')
})

test('todoSections: 終わった待ちは答え待ちのすぐ下の段（未読があっても未読の段には入れない）', () => {
  const sessions = [summary({ id: 'a@sai', last_kind: 'turn', last_turn_ts: END, unread: 2 })]
  const s = todoSections(todoItems(sessions, {}, SELF, {}, {}, { 'a@sai': [wait({})] }))
  assert.deepEqual([s.answer.length, s.wait.map((t) => t.wait?.id), s.unread.map((t) => t.kind), s.watch.length, s.done.length], [0, ['w1'], ['done'], 0, 0])
})

test('todoItems: 端末のターンが閉じたか分からずに止めたメッセージの預かりは watch で 1 行だけ出し、数える。ほかの理由で止めた預かりは出さない（#800）', () => {
  const s = summary({ id: 's1@sai', waiting: '許可待ち: Bash: ls' })
  const t = summary({ id: 's2@sai' })
  const queued = {
    's1@sai': { items: [{ queue_id: 'q1', text: 'x', since: '2026-10-14T00:00:00.000Z' }], paused: TERMINAL_UNKNOWN_PAUSED },
    's2@sai': { items: [{ queue_id: 'q2', text: 'y', since: '2026-10-14T00:00:00.000Z' }], paused: '前の返信が失敗したので止めています' },
  }
  const items = todoItems([s, t], {}, SELF, {}, {}, {}, queued)
  const mine = items.filter((i) => i.id === 's1@sai')
  assert.deepEqual(mine.map((i) => [i.kind, i.text, i.since]), [['watch', TERMINAL_STUCK_TEXT, '2026-10-14T00:00:00.000Z']], '同じセッションの watch と重ねない')
  assert.equal(pendingItems(mine).length, 1)
  assert.equal(items.some((i) => i.id === 's2@sai' && i.text === TERMINAL_STUCK_TEXT), false)
})
