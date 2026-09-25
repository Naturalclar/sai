// #382。OpenCode への返信が `opencode run -s`（ワンショット）ではなく `opencode serve` の HTTP へ行くこと。
// 本物の `opencode` には触らず、`opencodeApp` を差し替えて経路だけを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReplyResponse, SessionDetailResponse, SessionModelsResponse, SessionProgressResponse, SessionSkillsResponse } from '../shared/types.ts'
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
/** `POST /session` で作ったセッションの cwd（#452） */
const startedSessions: string[] = []
const started: { id: string; cmd: ReplyCommand }[] = []
/** いま `opencode serve` が答えを待っている許可（#421）。テストごとに差し替える */
let pending: OpencodePermission[] = []
/** 保留を引けたか（#422。false は「サーバが立っていない・読めない」） */
let pendingOk = true
let answerOk = true
const answered: { sessionId: string; permissionId: string; response: string }[] = []
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
    if (input.session === 'ses_ng') throw new Error('opencode serve が 404 を返しました')
    sent.push(input)
  },
  settle: () => [],
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
  stop: () => {},
} as OpencodeApp & { busy: boolean }

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
