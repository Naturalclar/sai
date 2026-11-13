import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canAddWorktree, START_SILENT_MS, startDraftChoices, startFromDraft, startStatus, workspaceChoices, workspaceLabel } from './newSession.ts'
import type { StartFromDraftApi } from './newSession.ts'
import type { NewSessionRequest, SessionSummary, SiblingWorktree, StartDraft } from '../../shared/types.ts'

const s = (over: Partial<SessionSummary>): SessionSummary =>
  ({ id: 'S@sai', cwd: '/w/sai', host: '', project: 'Naturalclar/sai', repo: 'sai', branch: 'main', end: '2026-09-11T10:00:00+09:00', ...over }) as SessionSummary

test('workspaceChoices: cwd ごとに 1 つ、その cwd の一番新しいセッションを from にして、新しい順（#314）', () => {
  const choices = workspaceChoices(
    [
      s({ id: 'old@dev-a', cwd: '/w/dev-a', repo: 'dev-a', branch: 'x', end: '2026-09-10T09:00:00+09:00' }),
      s({ id: 'new@dev-a', cwd: '/w/dev-a', repo: 'dev-a', branch: 'y', end: '2026-09-11T09:00:00+09:00' }),
      s({ id: 'main@sai', cwd: '/w/sai', end: '2026-09-11T11:00:00+09:00' }),
    ],
    'mac',
  )
  assert.deepEqual(choices.map((w) => w.from), ['main@sai', 'new@dev-a'])
  assert.equal(choices[1]?.branch, 'y', 'ブランチも一番新しいセッションのもの')
})

test('workspaceChoices: 別のマシンのものと cwd の分からないものは出さない。エージェントは問わない', () => {
  const choices = workspaceChoices(
    [
      s({ id: 'remote@r', cwd: '/w/remote', host: 'mini' }),
      s({ id: 'nocwd@r', cwd: '' }),
      s({ id: 'codex@r', cwd: '/w/codex', agent: 'codex' }),
      s({ id: 'mine@r', cwd: '/w/mine', host: 'MAC' }),
    ],
    'mac',
  )
  assert.deepEqual(choices.map((w) => w.from).sort(), ['codex@r', 'mine@r'], 'host の大文字小文字は問わない（isRemoteHost）')
})

test('workspaceLabel: リポジトリ · worktree（ブランチ）。分からないところは省く', () => {
  const w = workspaceChoices([s({})], '')[0]!
  assert.equal(workspaceLabel(w), 'Naturalclar/sai · sai（main）')
  assert.equal(workspaceLabel({ ...w, project: '', branch: '' }), 'sai')
})

test('startStatus: 最初の行が届いたら移る。届く前に落ちたら理由、CLI が終わっても届かなければ記録の問題（#314）', () => {
  const since = Date.parse('2026-09-11T12:00:00+09:00')
  const running = { since: '2026-09-11T12:00:00+09:00', text: 'x' }
  assert.deepEqual(startStatus(false, running, since, since + 2000), { kind: 'running' })
  assert.deepEqual(startStatus(true, running, since, since + 2000), { kind: 'arrived' }, '届いたらプロセスがまだ動いていても移る')
  assert.deepEqual(startStatus(false, { ...running, failed: { code: 1, tail: 'Invalid API key' } }, since, since + 5000), { kind: 'failed', message: 'Invalid API key' })
  assert.match((startStatus(false, { ...running, failed: { code: 1, tail: 'boom', logged_out: true } }, since, since + 5000) as { message: string }).message, /^Claude のログインが切れています.*boom$/, 'ログイン切れ（#685）は理由を先に出す')
  assert.deepEqual(startStatus(false, { ...running, failed: { code: 2, tail: '' } }, since, since + 5000), { kind: 'failed', message: '終了コード 2' })
  // 送った直後はまだ一覧に replying が載っていない（ポーリング待ち）ので、落ちたとは決めない
  assert.deepEqual(startStatus(false, undefined, since, since + 3000), { kind: 'running' })
  assert.deepEqual(startStatus(false, undefined, since, since + START_SILENT_MS + 1), { kind: 'silent' })
  assert.deepEqual(startStatus(false, running, since, since + START_SILENT_MS + 1), { kind: 'running' }, '動いている間は待つ（長いターン）')
})

test('workspaceChoices: 始められる場所（#319）があれば git の作業ツリーの中だけに絞り、記録の無い兄弟 worktree を後ろに足す', () => {
  const sessions = [
    s({ id: 'a@dev-a', cwd: '/w/app.git/dev-a', repo: 'dev-a', end: '2026-09-11T09:00:00+09:00' }),
    s({ id: 'tmp@tmp', cwd: '/tmp', repo: 'tmp', end: '2026-09-11T10:00:00+09:00' }),
  ]
  const places = {
    recorded: ['a@dev-a'],
    addable: [],
    siblings: [{ from: 'a@dev-a', worktree: 'k1', cwd: '/w/app.git/dev-b', repo: 'dev-b', branch: 'dev-b', project: 'me/app' }],
  }
  const choices = workspaceChoices(sessions, '', places)
  assert.deepEqual(choices.map((w) => [w.key, w.from, w.worktree]), [
    ['a@dev-a', 'a@dev-a', undefined],
    ['a@dev-a#k1', 'a@dev-a', 'k1'],
  ], '/tmp は落ち、兄弟は同じ from でも別の鍵で並ぶ')
  assert.equal(workspaceLabel(choices[1]!), 'me/app · dev-b（dev-b） · 記録なし')
  // 取れなかった（null）ときは今までどおり絞らない（サーバが始めるときに断る）
  assert.deepEqual(workspaceChoices(sessions, '', null).map((w) => w.key), ['tmp@tmp', 'a@dev-a'])
})

test('canAddWorktree: addable にあるものだけ。古いサーバの応答（addable が無い）では出さず、落ちない（#847 のレビュー）', () => {
  assert.equal(canAddWorktree({ recorded: [], siblings: [], addable: ['a@dev-a'] }, 'a@dev-a'), true)
  assert.equal(canAddWorktree({ recorded: [], siblings: [], addable: ['a@dev-a'] }, 'b@dev-b'), false)
  assert.equal(canAddWorktree({ recorded: [], siblings: [] }, 'a@dev-a'), false)
  assert.equal(canAddWorktree(null, 'a@dev-a'), false)
})

const draft = (over: Partial<StartDraft> = {}): StartDraft => ({ name: 'task-a', agent: 'claude', text: 'やって', at: 1_000, ...over })

test('startDraftChoices: 24 時間以内・アーカイブ済みでない・このマシンの案を新しい順に（#892）', () => {
  const now = 2_000
  const list = startDraftChoices(
    [
      s({ id: 'a@repo-a', start_draft: draft({ at: 1_000 }) }),
      s({ id: 'b@repo-a', start_draft: draft({ at: 1_500 }) }),
      s({ id: 'c@repo-a', start_draft: draft(), archived: true }),
      s({ id: 'd@repo-a', start_draft: draft(), host: 'far-away' }),
      s({ id: 'e@repo-a' }),
    ],
    'mac',
    now,
  )
  assert.deepEqual(list.map((c) => c.from), ['b@repo-a', 'a@repo-a'])
})

/** 偽の口。呼ばれた順と中身を覚える */
const fakeApi = (fail: { add?: string; start?: string } = {}) => {
  const calls: unknown[][] = []
  const sibling: SiblingWorktree = { from: 'a@repo-a', worktree: 'key-1', cwd: '/w/task-a', repo: 'task-a', branch: 'task-a', project: 'owner-a/repo-a' }
  const api: StartFromDraftApi = {
    addWorktree: async (from, name) => {
      calls.push(['addWorktree', from, name])
      if (fail.add) throw new Error(fail.add)
      return { worktree: sibling }
    },
    startSession: async (body: NewSessionRequest) => {
      calls.push(['startSession', body])
      if (fail.start) throw new Error(fail.start)
      return { accepted: true, id: 'n@task-a', agent: 'claude', session: 'n', cwd: '/w/task-a', via: 'process' }
    },
    startDraftAction: async (id, body) => {
      calls.push(['startDraftAction', id, body])
      return { id, taken: true }
    },
  }
  return { api, calls, sibling }
}

test('startFromDraft: 今の画面と同じ口を順に通す（worktree を作る → その鍵で始める → 案を片付ける）（#892）', async () => {
  const { api, calls, sibling } = fakeApi()
  const out = await startFromDraft(api, { from: 'a@repo-a', draft: draft({ at: 7 }), created: null, body: { text: 'やって', agent: 'codex' } })
  assert.equal(out.ok, true)
  assert.deepEqual(calls, [
    ['addWorktree', 'a@repo-a', 'task-a'],
    ['startSession', { text: 'やって', agent: 'codex', from: sibling.from, worktree: sibling.worktree }],
    ['startDraftAction', 'a@repo-a', { at: 7 }],
  ])
})

test('startFromDraft: 作れなければ始めない。作ったあとで始められなければ、できた worktree を返し、押し直しは作らずに始める（#892）', async () => {
  const refused = fakeApi({ add: 'もうあります' })
  const a = await startFromDraft(refused.api, { from: 'a@repo-a', draft: draft(), created: null, body: { text: 'x' } })
  assert.deepEqual([a.ok, refused.calls.map((c) => c[0])], [false, ['addWorktree']])
  assert.match(a.ok ? '' : a.error, /worktree を作れませんでした: もうあります/)

  const failing = fakeApi({ start: 'ログインが切れています' })
  const b = await startFromDraft(failing.api, { from: 'a@repo-a', draft: draft(), created: null, body: { text: 'x' } })
  assert.equal(b.ok, false)
  assert.deepEqual(b.ok ? null : b.sibling, failing.sibling, '案は片付けない・できた worktree を返す')
  assert.deepEqual(failing.calls.map((c) => c[0]), ['addWorktree', 'startSession'])

  const retry = fakeApi()
  const c = await startFromDraft(retry.api, { from: 'a@repo-a', draft: draft(), created: failing.sibling, body: { text: 'x' } })
  assert.equal(c.ok, true)
  assert.deepEqual(retry.calls.map((x) => x[0]), ['startSession', 'startDraftAction'], '押し直しは作らない')
})
