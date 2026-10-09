// #382。OpenCode への返信が `opencode run -s`（ワンショット）ではなく `opencode serve` の HTTP へ行くこと。
// 本物の `opencode` には触らず、`opencodeApp` を差し替えて経路だけを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReplyQueueResponse, ReplyResponse, SessionDetailResponse, SessionModelsResponse, SessionProgressResponse, SessionSkillsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import { Authenticator } from './auth.ts'
import { TerminalReplies } from './reply/terminal.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'
import type { OpencodeApp, OpencodeTurnInput } from './reply/opencodeServer.ts'
import { parsePermissions, permissionApprovalId } from '../shared/opencodePermissions.ts'
import type { OpencodePermission } from '../shared/opencodePermissions.ts'
import { REAL_PERMISSION, REAL_PERMISSION_TEXT } from '../shared/opencodePermissions.test.ts'
import type { NewSessionResponse, SessionsResponse } from '../shared/types.ts'

let dir: string
let work: string
let server: Server
let base: string
const sent: OpencodeTurnInput[] = []
const skillCalls: string[] = []
const modelCalls: string[] = []
const todoCalls: string[] = []
/** 読んだ量を聞かれたセッション（#396） */
const contextCalls: string[] = []
/** `POST /session` で作ったセッションの cwd（#452） */
const startedSessions: string[] = []
const started: { id: string; cmd: ReplyCommand }[] = []
/** `POST /session/<id>/fork` で分岐した元のセッションと cwd（#398）。分岐先の id は `nextFork`（投げさせるなら `forkFails`） */
const forks: { session: string; cwd: string }[] = []
let nextFork = 'ses_forked'
let forkFails = false
/** いま `opencode serve` が答えを待っている許可（#421）。テストごとに差し替える */
let pending: OpencodePermission[] = []
/** 保留を引けたか（#422。false は「サーバが立っていない・読めない」） */
let pendingOk = true
let answerOk = true
const answered: { sessionId: string; permissionId: string; response: string }[] = []
/** 「止める」で呼ばれたエンティティ（#392） */
const aborted: string[] = []
/** 止められるか（false は「止められなかった」） */
let abortOk = true
/** `GET /permission` に渡した `directory`（#421。渡さないと空が返るので、渡していることをテストで留める） */
const permissionDirs: string[][] = []
const runner: Runner = { running: () => false, snapshot: () => ({}), async start(id, cmd) { started.push({ id, cmd }) } }
/** 送ったぶんを覚え、`busy` で「処理中」を作れる偽の serve */
const opencodeApp: OpencodeApp = {
  busy: false,
  running(id: string) {
    return this.busy && id === 'ses_1@r'
  },
  replying: () => ({}),
  async start(input: OpencodeTurnInput) {
    // `ses_fail` は、分岐はできたが 1 ターン目を始められない分岐先（#398）
    if (input.session === 'ses_ng' || input.session === 'ses_fail') throw new Error('opencode serve が 404 を返しました')
    sent.push(input)
  },
  settle: () => [],
  async abort(this: OpencodeApp & { busy: boolean }, id: string) {
    aborted.push(id)
    if (!abortOk) return false
    // 本物も止めたら処理中から外す
    this.busy = false
    return true
  },
  async permissions(dirs: readonly string[]) {
    permissionDirs.push([...dirs])
    return { ok: pendingOk, list: pending }
  },
  async answerPermission(sessionId: string, permissionId: string, response: 'once' | 'reject') {
    answered.push({ sessionId, permissionId, response })
    return answerOk
  },
  async skills(cwd: string) {
    skillCalls.push(cwd)
    return [
      { name: 'demo-skill', description: 'プロジェクトのスキル', source: 'user' as const },
      { name: 'init', description: 'guided AGENTS.md setup', source: 'command' as const },
    ]
  },
  async models(cwd: string) {
    modelCalls.push(cwd)
    return ['openai/gpt-6-astra', 'ollama/qwen3:8b']
  },
  async startSession(cwd: string) {
    startedSessions.push(cwd)
    if (cwd === '/bad') throw new Error('opencode serve が 500 を返しました')
    return 'ses_new'
  },
  async turnRunning(session: string, cwd: string) {
    busyAsked.push({ session, cwd })
    return busyOnServe.has(session)
  },
  async fork(session: string, cwd: string) {
    forks.push({ session, cwd })
    if (forkFails) throw new Error('opencode serve が 404 を返しました')
    return nextFork
  },
  async todos(session: string) {
    todoCalls.push(session)
    return {
      todos: [
        { content: '調べる', status: 'completed', priority: 'medium' },
        { content: '直す', status: 'in_progress', priority: 'medium' },
        { content: '確かめる', status: 'pending', priority: 'medium' },
      ],
      children: 1,
    }
  },
  async context(session: string) {
    contextCalls.push(session)
    return session === 'ses_1' ? 250_000 : 0
  },
  stop: () => {},
} as OpencodeApp & { busy: boolean }

/** serve の上で「いま回っている」と見せる OpenCode のセッション（#398。SAI が数えていないターン） */
const busyOnServe = new Set<string>()
/** `GET /session/status` を聞いたセッションと cwd */
const busyAsked: { session: string; cwd: string }[] = []

const saved = process.env.AGENT_FEED_HOST
const now = new Date()

const app = (): ReturnType<typeof createApp> =>
  createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    runner,
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async () => null),
    { tmux: { run: async () => { throw new Error('no tmux') } }, ps: async () => '', replies: new TerminalReplies(), opencodeApp },
  )

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-oc-'))
  work = await mkdtemp(join(tmpdir(), 'sai-oc-work-'))
  // 新しいセッションを始められるのは git の作業ツリーの中だけ（#319）
  execFileSync('git', ['init', '-q', work])
  await writeFile(
    join(dir, `${localDate(now.toISOString())}.jsonl`),
    [
      JSON.stringify(row(new Date(now.getTime() - 60_000), 'ses_1', { agent: 'opencode', repo: 'r', cwd: work, host: 'testmac', model: 'ollama/qwen3:8b' })),
      JSON.stringify(row(new Date(now.getTime() - 30_000), 'ses_ng', { agent: 'opencode', repo: 'r', cwd: work, host: 'testmac' })),
      // 許可で止まっている（プラグインが書く待ちの行。#421。これがあるセッションの cwd に保留を聞きに行く）
      JSON.stringify(row(new Date(now.getTime() - 10_000), 'ses_1', { agent: 'opencode', repo: 'r', cwd: work, host: 'testmac', event: 'permission.asked', text: '許可待ち: external_directory: /etc/hosts', user_text: '' })),
      // 聞いてきたプロセスがもう居ない待ち（#422。SAI を立て直したあとの取り残し）。pid は存在しえない値
      JSON.stringify(row(new Date(now.getTime() - 20_000), 'ses_dead', { agent: 'opencode', repo: 'r', cwd: work, host: 'testmac', event: 'permission.asked', text: '許可待ち: external_directory: /etc/hosts', user_text: '', pid: 999_999 })),
    ].join('\n') + '\n',
  )
  const handler = app()
  server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  if (saved === undefined) delete process.env.AGENT_FEED_HOST
  else process.env.AGENT_FEED_HOST = saved
  await new Promise<void>((r) => server.close(() => r()))
  await rm(dir, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

test('OpenCode の返信は serve へ送る（子プロセスは起こさない）', async () => {
  const res = await post('/api/sessions/ses_1%40r/reply', { text: 'テストして' })
  assert.equal(res.status, 202)
  const body = (await res.json()) as ReplyResponse
  assert.equal(body.via, 'app-server')
  assert.equal(body.session, 'ses_1')
  assert.deepEqual(sent.map((s) => ({ id: s.id, session: s.session, text: s.text })), [{ id: 'ses_1@r', session: 'ses_1', text: 'テストして' }])
  assert.equal(started.length, 0, '`opencode run -s` は起こさない')
})

test('送れなければ 500 で理由を出す（画面の「送信失敗」に出る）', async () => {
  const res = await post('/api/sessions/ses_ng%40r/reply', { text: 'だめな方' })
  assert.equal(res.status, 500)
  assert.match((await res.text()), /opencode serve/)
})

test('処理中なら預かる（#305 と同じ。二重にターンを走らせない）', async () => {
  ;(opencodeApp as OpencodeApp & { busy: boolean }).busy = true
  try {
    const queued = await post('/api/sessions/ses_1%40r/reply', { text: 'あとで', queue: true })
    assert.equal(queued.status, 202)
    assert.equal(((await queued.json()) as ReplyResponse).via, 'queued')
    const refused = await post('/api/sessions/ses_1%40r/reply', { text: '割り込み' })
    assert.equal(refused.status, 409, 'queue を付けなければ今までどおり 409')
    assert.equal(sent.length, 1, '処理中の間は送らない')
    const detail = (await (await fetch(`${base}/api/sessions/ses_1%40r`)).json()) as SessionDetailResponse
    assert.equal(detail.queued['ses_1@r']?.items[0]?.text, 'あとで', '預かりは画面の QueuedBubble に出る')
  } finally {
    ;(opencodeApp as OpencodeApp & { busy: boolean }).busy = false
  }
})

test('SAI_OPENCODE_SERVER=0 なら今までどおり `opencode run -s` に戻す', async () => {
  const before = process.env.SAI_OPENCODE_SERVER
  process.env.SAI_OPENCODE_SERVER = '0'
  const handler = app()
  const s2 = createServer((req, res) => void handler(req, res))
  await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r))
  const addr = s2.address()
  const b2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    const res = await fetch(`${b2}/api/sessions/ses_1%40r/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: b2 },
      body: JSON.stringify({ text: '旧経路' }),
    })
    assert.equal(res.status, 202)
    assert.equal(((await res.json()) as ReplyResponse).via, 'process')
    assert.deepEqual(started.at(-1)?.cmd.args.slice(0, 3), ['run', '-s', 'ses_1'])
  } finally {
    if (before === undefined) delete process.env.SAI_OPENCODE_SERVER
    else process.env.SAI_OPENCODE_SERVER = before
    await new Promise<void>((r) => s2.close(() => r()))
  }
})

test('`/` の候補は OpenCode の本体に聞く（#393。セッションの cwd を渡す）', async () => {
  const res = await fetch(`${base}/api/sessions/ses_1%40r/skills`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as SessionSkillsResponse
  assert.deepEqual(body.skills.map((s) => `${s.source}:${s.name}`), ['user:demo-skill', 'command:init'])
  assert.deepEqual(skillCalls, [work], 'サーバの cwd ではなく、そのセッションの cwd で引く')
})

test('返信のモデル候補は OpenCode の本体に聞く（#394。セッションの cwd を渡す）', async () => {
  const res = await fetch(`${base}/api/sessions/ses_1%40r/models`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as SessionModelsResponse
  assert.deepEqual(body.models, ['openai/gpt-6-astra', 'ollama/qwen3:8b'])
  assert.deepEqual(modelCalls, [work], 'worktree ごとに設定が違うので cwd を渡す')
})

/** #421。実物の保留を `ses_1@r` のものとして流し込む */
const asPending = (over: Partial<OpencodePermission> = {}) =>
  parsePermissions([{ ...REAL_PERMISSION, sessionID: 'ses_1', ...over }])

test('OpenCode の許可待ちが、答えられるバブルとして出る（#421）', async () => {
  pending = asPending()
  try {
    const list = (await (await fetch(`${base}/api/sessions`)).json()) as SessionsResponse
    const approval = list.approvals['ses_1@r']?.[0]
    assert.ok(approval, '一覧の approvals に載る')
    assert.equal(approval.text, REAL_PERMISSION_TEXT, '何を聞かれているかまで出る')
    assert.equal(approval.agent, 'opencode')
    assert.equal(approval.answerable, true)
    assert.deepEqual(approval.decisions?.map((d) => d.id), ['once', 'reject'])
    const detail = (await (await fetch(`${base}/api/sessions/ses_1%40r`)).json()) as SessionDetailResponse
    assert.equal(detail.approvals['ses_1@r']?.[0]?.approval_id, permissionApprovalId(REAL_PERMISSION.id), '詳細にも同じものが載る')
  } finally {
    pending = []
  }
})

test('保留は「そのセッションの cwd」を渡して引く（#421。directory が無いと空が返る）', async () => {
  permissionDirs.length = 0
  await fetch(`${base}/api/sessions`)
  assert.deepEqual(permissionDirs.at(-1), [work], '待っているセッションの cwd を渡す')
})

test('許可・拒否を押すと、そのまま OpenCode に返る（#421）', async () => {
  pending = asPending()
  answered.length = 0
  try {
    await fetch(`${base}/api/sessions`) // バブルを出す（出したものだけ答えられる）
    const id = permissionApprovalId(REAL_PERMISSION.id)
    const res = await post(`/api/approvals/${id}/answer`, { behavior: 'allow', decision: 'once' })
    assert.equal(res.status, 200)
    assert.deepEqual(answered, [{ sessionId: 'ses_1', permissionId: REAL_PERMISSION.id, response: 'once' }])
    // 答えたものは消える（二度は押せない）
    assert.equal((await post(`/api/approvals/${id}/answer`, { behavior: 'deny', decision: 'reject' })).status, 404)
  } finally {
    pending = []
  }
})

test('出していない選択（常に許可）と別オリジンは断る（#421）', async () => {
  pending = asPending({ id: 'per_deny' })
  answered.length = 0
  try {
    await fetch(`${base}/api/sessions`)
    const id = permissionApprovalId('per_deny')
    assert.equal((await post(`/api/approvals/${id}/answer`, { behavior: 'allow', decision: 'always' })).status, 400, '「常に許可」は出していない')
    assert.equal((await post(`/api/approvals/${id}/answer`, { behavior: 'allow', remember: 'local' })).status, 400, 'ルールの記憶も受けない')
    const cross = await fetch(`${base}/api/approvals/${id}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ behavior: 'allow', decision: 'once' }),
    })
    assert.equal(cross.status, 403, '同一オリジンのみ')
    assert.deepEqual(answered, [], 'どれも本体には届かない')
    // 拒否は届く
    assert.equal((await post(`/api/approvals/${id}/answer`, { behavior: 'deny', decision: 'reject' })).status, 200)
    assert.deepEqual(answered, [{ sessionId: 'ses_1', permissionId: 'per_deny', response: 'reject' }])
  } finally {
    pending = []
  }
})

test('記録に無いセッションの保留は出さない。届かなければ 409（#421）', async () => {
  pending = asPending({ id: 'per_other', sessionID: 'ses_知らない' })
  try {
    const list = (await (await fetch(`${base}/api/sessions`)).json()) as SessionsResponse
    assert.equal(Object.keys(list.approvals).length, 0, '行にないセッションの保留は載せない')
    assert.equal((await post(`/api/approvals/${permissionApprovalId('per_other')}/answer`, { behavior: 'allow', decision: 'once' })).status, 404)
    // 本体が受け取らなかった（サーバが落ちた・保留がもう無い）ときは 409 にして、次のポーリングで消す
    pending = asPending({ id: 'per_gone' })
    answerOk = false
    await fetch(`${base}/api/sessions`)
    assert.equal((await post(`/api/approvals/${permissionApprovalId('per_gone')}/answer`, { behavior: 'allow', decision: 'once' })).status, 409)
  } finally {
    answerOk = true
    pending = []
  }
})

test('答える相手が消えた待ちは畳む。記録は触らない（#422）', async () => {
  const list = (await (await fetch(`${base}/api/sessions`)).json()) as SessionsResponse
  const dead = list.sessions.find((s) => s.id === 'ses_dead@r')
  assert.ok(dead, '一覧には出る（消すのは待ちの印だけ）')
  assert.equal(dead.waiting, '', '聞いてきたプロセスが消えているので、待ちは畳む')
  // 詳細でも同じ（要対応・サイドバー・見出しがまとめて正しくなる）
  const detail = (await (await fetch(`${base}/api/sessions/ses_dead%40r`)).json()) as SessionDetailResponse
  assert.equal(detail.session.waiting, '')
  // 記録（JSONL）は触らない
  assert.equal(detail.rows.at(-1)?.event, 'permission.asked')
  assert.equal(detail.rows.at(-1)?.text, '許可待ち: external_directory: /etc/hosts')
})

test('保留が残っていれば、pid が死んでいても畳まない（#422）', async () => {
  pending = parsePermissions([{ ...REAL_PERMISSION, id: 'per_alive', sessionID: 'ses_dead' }])
  try {
    const list = (await (await fetch(`${base}/api/sessions`)).json()) as SessionsResponse
    assert.equal(list.sessions.find((s) => s.id === 'ses_dead@r')?.waiting, '許可待ち: external_directory: /etc/hosts', 'いま答えられるものは残す')
    assert.ok(list.approvals['ses_dead@r']?.[0], '答えられるバブルも出る')
  } finally {
    pending = []
  }
})

test('OpenCode の相手の大きさ（読み直す量）を本体に聞いて埋める（#396。#311 の予算がそのまま効く）', async () => {
  const body = (await (await fetch(`${base}/api/sessions/ses_1%40r/progress`)).json()) as SessionProgressResponse
  assert.equal(body.context_tokens, 250_000)
  assert.ok(contextCalls.includes('ses_1'), 'エンティティ ID ではなく OpenCode のセッション ID で聞く')
  const asked = contextCalls.length
  await fetch(`${base}/api/sessions/ses_1%40r/progress`)
  assert.equal(contextCalls.length, asked, '続けて聞かれても、しばらくは覚えた値を使う（sai_sessions は相手の数だけ一度に聞く）')
})

test('処理中の手順に、エージェント自身の段取りとサブセッションの数を足す（#397）', async () => {
  const res = await fetch(`${base}/api/sessions/ses_1%40r/progress`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as SessionProgressResponse
  // OpenCode は transcript を読めないので手順は空のまま。段取りは本体から取る
  assert.deepEqual(body.steps, [])
  assert.deepEqual(body.todos?.map((t) => `${t.status}:${t.content}`), ['completed:調べる', 'in_progress:直す', 'pending:確かめる'])
  assert.equal(body.children, 1, 'サブセッションはまず数だけ')
  assert.ok(todoCalls.includes('ses_1'), 'エンティティ ID ではなく OpenCode のセッション ID で聞く')
  // 中身が同じなら rev も同じ。進んだら変わるように、状態を混ぜてある
  const again = (await (await fetch(`${base}/api/sessions/ses_1%40r/progress`)).json()) as SessionProgressResponse
  assert.equal(again.rev, body.rev)
  assert.match(body.rev, /completedin_progresspending/)
})

test('POST /api/sessions/new: OpenCode は serve に作らせた id で始める（#452）', async () => {
  const before = sent.length
  const ranBefore = started.length
  const res = await post('/api/sessions/new', { from: 'ses_1@r', agent: 'opencode', text: '#400 に着手して' })
  assert.equal(res.status, 202)
  const body = (await res.json()) as NewSessionResponse
  assert.deepEqual({ id: body.id, agent: body.agent, session: body.session, via: body.via }, {
    id: 'ses_new@r',
    agent: 'opencode',
    session: 'ses_new',
    via: 'app-server',
  })
  assert.equal(body.cwd, work, 'cwd はリクエストからではなく from の行から取る')
  assert.deepEqual(startedSessions, [work], 'POST /session はその worktree で作る')
  // 作っただけでは記録に行が無いので、1 ターン目をそのまま回す
  assert.deepEqual(sent.slice(before).map((s) => ({ id: s.id, session: s.session, text: s.text })), [
    { id: 'ses_new@r', session: 'ses_new', text: '#400 に着手して' },
  ])
  assert.equal(started.length, ranBefore, '`opencode run` は起こさない')
})

test('POST /api/sessions/new: SAI_OPENCODE_SERVER=0 では OpenCode を始めない（run に落とさない。#452）', async () => {
  // run は許可を人に聞かず自動 reject するので、始めた 1 ターンが許可ひとつで無駄になる
  const saved = process.env.SAI_OPENCODE_SERVER
  process.env.SAI_OPENCODE_SERVER = '0'
  const handler = app()
  const off = createServer((req, res) => void handler(req, res))
  await new Promise<void>((r) => off.listen(0, '127.0.0.1', r))
  const addr = off.address()
  const offBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    const res = await fetch(`${offBase}/api/sessions/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: offBase },
      body: JSON.stringify({ from: 'ses_1@r', agent: 'opencode', text: 'x' }),
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /SAI_OPENCODE_SERVER=0/)
  } finally {
    if (saved === undefined) delete process.env.SAI_OPENCODE_SERVER
    else process.env.SAI_OPENCODE_SERVER = saved
    await new Promise<void>((r) => off.close(() => r()))
  }
})

test('dispose: SAI が起こした opencode serve を落とす（#457。main.ts の shutdown が呼ぶ）', () => {
  let stopped = 0
  const handler = createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    runner,
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async () => null),
    { tmux: { run: async () => { throw new Error('no tmux') } }, ps: async () => '', replies: new TerminalReplies(), opencodeApp: { ...opencodeApp, stop: () => void stopped++ } },
  )
  handler.dispose()
  assert.equal(stopped, 1)
})

test('処理中の OpenCode のターンを止める。預かりは勝手に回さない（#392。口は Codex と同じ interrupt）', async () => {
  const oc = opencodeApp as OpencodeApp & { busy: boolean }
  aborted.length = 0
  assert.equal((await post('/api/sessions/ses_1%40r/interrupt', {})).status, 409, '処理中でなければ 409（止める先が無い）')
  assert.deepEqual(aborted, [], '回していないものには投げない')

  oc.busy = true
  try {
    // 止めたあとに勝手に回らないことを見るため、預かりに 1 件並べておく
    const queueId = ((await (await post('/api/sessions/ses_1%40r/reply', { text: '止めたあとに送る', queue: true })).json()) as ReplyResponse).queue_id!
    const cross = await fetch(`${base}/api/sessions/ses_1%40r/interrupt`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.local:8787' }, body: '{}' })
    assert.equal(cross.status, 403, '別オリジンからは止めさせない')

    // 止められなかったら 409 で、預かりは止めたままにしない
    abortOk = false
    assert.equal((await post('/api/sessions/ses_1%40r/interrupt', {})).status, 409)
    const kept = (await (await fetch(`${base}/api/sessions/ses_1%40r`)).json()) as SessionDetailResponse
    assert.equal(kept.queued['ses_1@r']?.paused, undefined, '止められなかったので預かりはそのまま')

    abortOk = true
    const res = await post('/api/sessions/ses_1%40r/interrupt', {})
    assert.equal(res.status, 200)
    assert.deepEqual(aborted, ['ses_1@r', 'ses_1@r'])
    const body = (await res.json()) as ReplyQueueResponse
    assert.match(body.queue.paused ?? '', /止めた/, '止めた直後に次の預かりを走らせない（人が「続けて送る」を押したときだけ）')
    assert.equal(oc.busy, false)

    // 片付け（ほかのテストに預かりを残さない）
    assert.equal((await fetch(`${base}/api/sessions/ses_1%40r/queue/${queueId}`, { method: 'DELETE', headers: { origin: base } })).status, 200)
  } finally {
    oc.busy = false
    abortOk = true
  }
})

// ---- #398: 会話を分岐する（口・形・断り方は Codex の分岐 #405 と同じ）

test('POST /api/sessions/<id>/fork: OpenCode のセッションを分岐して、分岐先で最初の指示を回す（#398）', async () => {
  forks.length = 0
  const sentBefore = sent.length
  const ranBefore = started.length
  const createdBefore = startedSessions.length
  // 元のセッションに表示名とモデルを付けておく（分岐先に引き継ぐ）
  const put = await fetch(`${base}/api/sessions/ses_ng%40r/meta`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ name: '検証', model: 'ollama/qwen3:8b' }) })
  assert.equal(put.status, 200)
  const res = await post('/api/sessions/ses_ng%40r/fork', { text: '別の案で試して', cwd: '/etc', model: 'x' })
  assert.equal(res.status, 202)
  const body = (await res.json()) as NewSessionResponse
  assert.deepEqual({ id: body.id, agent: body.agent, session: body.session, via: body.via }, { id: 'ses_forked@r', agent: 'opencode', session: 'ses_forked', via: 'app-server' })
  assert.equal(body.cwd, work, 'cwd はリクエストからではなく元のセッションの行から取る')
  assert.deepEqual(forks, [{ session: 'ses_ng', cwd: work }], '分岐するのは行から引いた元のセッション。directory を渡す')
  assert.deepEqual(sent.slice(sentBefore).map((x) => ({ id: x.id, session: x.session, text: x.text, model: x.model })), [
    { id: 'ses_forked@r', session: 'ses_forked', text: '別の案で試して', model: 'ollama/qwen3:8b' },
  ], '分岐先で 1 ターン目を回す（元のセッションには送らない）。モデルは元のメタから')
  assert.equal(started.length, ranBefore, '`opencode run` は起こさない')
  assert.equal(startedSessions.length, createdBefore, '新しいセッション（POST /session）は作らない')
  const meta = (await (await fetch(`${base}/api/sessions/${encodeURIComponent(body.id)}/meta`)).json()) as { meta: Record<string, unknown> }
  assert.deepEqual(meta.meta, { forked_from: 'ses_ng@r', model: 'ollama/qwen3:8b', name: '検証（分岐）' })
})

test('POST /api/sessions/<id>/fork: 別オリジン・本文なし・処理中・serve が断ったときは分岐しない。始まらなければメタを残さない（#398）', async () => {
  forks.length = 0
  const sentBefore = sent.length
  const cross = await fetch(`${base}/api/sessions/ses_ng%40r/fork`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ text: 'x' }) })
  assert.equal(cross.status, 403)
  assert.equal((await post('/api/sessions/ses_ng%40r/fork', { text: '  ' })).status, 400)
  assert.equal((await post('/api/sessions/nope%40r/fork', { text: 'x' })).status, 404)
  // 元のセッションが処理中のあいだは始めない（同じ作業ディレクトリで 2 本が同時に動く）
  ;(opencodeApp as OpencodeApp & { busy: boolean }).busy = true
  try {
    const busy = await post('/api/sessions/ses_1%40r/fork', { text: 'x' })
    assert.equal(busy.status, 409)
    assert.match(await busy.text(), /処理中/)
  } finally {
    ;(opencodeApp as OpencodeApp & { busy: boolean }).busy = false
  }
  assert.deepEqual(forks, [], 'ここまで 1 回も分岐していない')
  // SAI が数えていないターン（serve の側で回っている）も処理中として断る
  busyOnServe.add('ses_ng')
  try {
    assert.equal((await post('/api/sessions/ses_ng%40r/fork', { text: 'x' })).status, 409)
    assert.deepEqual(forks, [])
    assert.deepEqual(busyAsked.at(-1), { session: 'ses_ng', cwd: work }, '行から引いた元のセッションを、その cwd で聞く')
  } finally {
    busyOnServe.delete('ses_ng')
  }
  // 断ったあとは「起動中」から外れている（次の分岐・返信を止めない）
  // serve が断った（知らないセッション、など）→ 500 で理由。何も送らない
  forkFails = true
  try {
    const failed = await post('/api/sessions/ses_ng%40r/fork', { text: 'x' })
    assert.equal(failed.status, 500)
    assert.match(await failed.text(), /OpenCode のセッションを分岐できませんでした.*404/)
  } finally {
    forkFails = false
  }
  // 分岐はできたが 1 ターン目を始められなかった → 500。書いたメタは消す（行が無いので、画面からは消せない）
  nextFork = 'ses_fail'
  try {
    const notStarted = await post('/api/sessions/ses_ng%40r/fork', { text: 'x' })
    assert.equal(notStarted.status, 500)
    assert.match(await notStarted.text(), /OpenCode のセッションを始められませんでした/)
    assert.deepEqual(forks.at(-1), { session: 'ses_ng', cwd: work }, '分岐までは進んでいる')
    const left = (await (await fetch(`${base}/api/sessions/ses_fail%40r/meta`)).json()) as { meta?: Record<string, unknown> }
    assert.deepEqual(left.meta ?? {}, {}, '分岐元・表示名・モデルを書いたメタが残っていない')
  } finally {
    nextFork = 'ses_forked'
  }
  assert.equal(sent.length, sentBefore, '1 回も送っていない')
})

test('POST /api/sessions/<id>/fork: SAI_OPENCODE_SERVER=0 では分岐しない（run に落とさない。#398）', async () => {
  const savedEnv = process.env.SAI_OPENCODE_SERVER
  process.env.SAI_OPENCODE_SERVER = '0'
  const handler = app()
  const off = createServer((req, res) => void handler(req, res))
  await new Promise<void>((r) => off.listen(0, '127.0.0.1', r))
  const addr = off.address()
  const offBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  forks.length = 0
  try {
    const res = await fetch(`${offBase}/api/sessions/ses_ng%40r/fork`, { method: 'POST', headers: { 'content-type': 'application/json', origin: offBase }, body: JSON.stringify({ text: 'x' }) })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /SAI_OPENCODE_SERVER=0/)
    assert.deepEqual(forks, [])
  } finally {
    if (savedEnv === undefined) delete process.env.SAI_OPENCODE_SERVER
    else process.env.SAI_OPENCODE_SERVER = savedEnv
    await new Promise<void>((r) => off.close(() => r()))
  }
})
