// ターン完了の行が落ちた・本文が空だったターンの返答を transcript から補う（#614）。
// 本物の createApp と本物の ProgressReader に作った transcript を読ませて、詳細・一覧に補った行が載ること、
// JSONL は変わらないこと、`turns` は進まず未読は進むこと、前のターンの返答を出さないことを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { ProgressReader } from './local/progress.ts'
import { Approvals } from './approvals/approvals.ts'
import { UsageStore } from './local/usage.ts'
import { READ_MARKS_FILE } from './meta/reads.ts'
import { claudeProjectName } from '../shared/progress.ts'
import { deliveredFromTailnet, replyOf } from '../shared/agentMessages.ts'
import type { FeedRow, SessionDetailResponse, SessionsResponse } from '../shared/types.ts'

let dir: string
let server: Server
let base: string
let feedFile: string
let feedBefore: string

const now = new Date()
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000)
const user = (at: Date, content: string) => JSON.stringify({ type: 'user', timestamp: at.toISOString(), message: { role: 'user', content } })
const said = (at: Date, text: string, stop: string) => JSON.stringify({ type: 'assistant', timestamp: at.toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop } })
const tool = (at: Date) => JSON.stringify({ type: 'assistant', timestamp: at.toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }], stop_reason: 'tool_use' } })
const MESSAGE = deliveredFromTailnet('me@example.com', 'abcdef0123456789', '#583 に着手して')
const input = (at: Date, session: string, text: string, over: Partial<FeedRow> = {}) => row(at, session, { repo: 'repo', cwd: dir, agent: 'claude', event: 'UserPromptSubmit', user_text: text, text: '', ...over })
const stop = (at: Date, session: string, userText: string, text: string) => row(at, session, { repo: 'repo', cwd: dir, agent: 'claude', user_text: userText, text })

const detail = async (id: string) => (await (await fetch(`${base}/api/sessions/${encodeURIComponent(`${id}@repo`)}?days=2`)).json()) as SessionDetailResponse
const recoveredOf = async (id: string) => (await detail(id)).rows.filter((r) => r.recovered)

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-recovered-'))
  const feedDir = join(dir, 'feed')
  const projectDir = join(dir, 'projects', claudeProjectName(dir))
  await mkdir(feedDir)
  await mkdir(projectDir, { recursive: true })
  const t = (name: string, lines: string[]) => writeFile(join(projectDir, `${name}.jsonl`), lines.join('\n') + '\n')
  // 最後のターンの行が落ちた（5 分前に閉じている）
  await t('LATEST', [user(ago(40), '前の指示'), said(ago(39), '前のターンの返答', 'end_turn'), user(ago(10), 'PR を出して'), tool(ago(9)), said(ago(5), 'PR #620 を出しました\n詳しくは…', 'end_turn')])
  // 古いターンの行が落ちた（メッセージで起こしたターン）。そのあとにふつうのターンが続いている
  await t('OLD', [user(ago(30), MESSAGE), said(ago(25), '#583 は PR #610 です', 'end_turn'), user(ago(20), 'マージして'), said(ago(15), 'マージしました', 'end_turn')])
  // ターン完了の行はあるが本文が空（#613 の、締切に間に合わなかったときの行）
  await t('EMPTY', [user(ago(10), 'PR を出して'), said(new Date(ago(5).getTime() - 3000), 'PR #621 を出しました', 'end_turn')])
  // まだ回っている・閉じたのは前のターン・Esc で止めて次へ進んだ、は補わない
  await t('RUNNING', [user(ago(10), 'PR を出して'), tool(ago(9))])
  await t('EARLIER', [user(ago(30), '前の指示'), said(ago(20), '前のターンの返答', 'end_turn')])
  await t('STOPPED', [user(ago(30), '長い作業'), said(ago(29), '途中の地の文', 'tool_use'), user(ago(20), '別のことをして'), said(ago(15), 'しました', 'end_turn')])
  // 端末のセッション: 落ちたターンの 1 分あとに「入力待ち」の行が来る／許可を端末で答えたあとターン完了が落ちた
  await t('IDLE', [user(ago(10), 'PR を出して'), said(ago(5), 'PR #622 を出しました', 'end_turn')])
  await t('ASKED', [user(ago(10), 'PR を出して'), tool(ago(9)), said(ago(5), 'PR #623 を出しました', 'end_turn')])
  await t('REMOTE', [user(ago(10), 'PR を出して'), said(ago(5), '別のマシンの返答', 'end_turn')])
  const lines = [
    stop(ago(39), 'LATEST', '前の指示', '前のターンの返答'),
    input(ago(10), 'LATEST', 'PR を出して'),
    input(ago(30), 'OLD', MESSAGE),
    input(ago(20), 'OLD', 'マージして'),
    stop(ago(15), 'OLD', 'マージして', 'マージしました'),
    input(ago(10), 'EMPTY', 'PR を出して'),
    stop(ago(5), 'EMPTY', 'PR を出して', ''),
    input(ago(10), 'RUNNING', 'PR を出して'),
    input(ago(10), 'EARLIER', 'PR を出して'),
    input(ago(30), 'STOPPED', '長い作業'),
    input(ago(20), 'STOPPED', '別のことをして'),
    stop(ago(15), 'STOPPED', '別のことをして', 'しました'),
    input(ago(10), 'REMOTE', 'PR を出して', { host: 'far-away-machine' }),
    input(ago(10), 'NOFILE', 'PR を出して'),
    stop(ago(40), 'IDLE', '前の指示', '前のターンの返答'),
    input(ago(10), 'IDLE', 'PR を出して'),
    row(ago(4), 'IDLE', { repo: 'repo', cwd: dir, agent: 'claude', event: 'Notification', text: '入力待ち', user_text: '' }),
    input(ago(10), 'ASKED', 'PR を出して'),
    row(ago(9), 'ASKED', { repo: 'repo', cwd: dir, agent: 'claude', event: 'PermissionRequest', text: '許可待ち: Bash: pnpm test', user_text: '' }),
  ].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  feedFile = join(feedDir, `${localDate(now.toISOString())}.jsonl`)
  feedBefore = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  await writeFile(feedFile, feedBefore)
  // 未読の起点を 1 時間前に置く（無ければ「いま」から数え始めるので、補った返答が既読になる）
  await writeFile(join(feedDir, READ_MARKS_FILE), JSON.stringify({ since: ago(60).getTime(), sessions: {} }) + '\n')
  const app = createApp(
    new FeedStore(feedDir), join(dir, 'dist'), undefined, new Approvals(), undefined, undefined, undefined,
    { tmux: { run: async () => '' }, ps: async () => '' }, undefined, undefined, undefined,
    new UsageStore(join(dir, 'codex'), join(dir, 'projects'), feedDir),
    new ProgressReader(join(dir, 'projects'), join(dir, 'codex')),
  )
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

test('最後のターンの行が落ちた: 詳細に補った返答が載り、一覧は「終わって次を待っている」になる。turns は進まず未読は進む。JSONL は変わらない（#614）', async () => {
  const d = await detail('LATEST')
  const got = d.rows.filter((r) => r.recovered)
  assert.equal(got.length, 1)
  assert.deepEqual([got[0]!.event, got[0]!.text, got[0]!.user_text], ['Stop', 'PR #620 を出しました\n詳しくは…', 'PR を出して'], '前のターンの返答ではなく、そのターンの返答')
  assert.equal(d.rows.at(-1), d.rows.find((r) => r.recovered), '入力の行のあとに並ぶ')
  assert.equal(d.rows.length, 3, '記録の 2 行 + 補った 1 行')

  const list = (await (await fetch(`${base}/api/sessions?days=2`)).json()) as SessionsResponse
  const s = list.sessions.find((x) => x.id === 'LATEST@repo')!
  assert.equal(s.last_kind, 'turn', '要対応では下段（終わって次を待っている）')
  assert.equal(s.last_text, 'PR #620 を出しました')
  assert.equal(s.waiting, '')
  assert.equal(s.turns, 1, 'turns は Stop の行だけで数える（補った分は数えない）')
  assert.equal(s.unread, 2, '未読は進める（前のターンと、補った返答）')
  assert.equal(s.stop_missing, undefined, '返答を補えたら見出しの「完了の記録なし」は出さない（バブルの「記録から補った」で分かる）')
  assert.equal(await readFile(feedFile, 'utf-8'), feedBefore, 'SAI は JSONL に行を書かない')
})

test('古いターンの行が落ちた（メッセージで起こしたターン）: 裏で transcript を読み、次の応答から載る。返答の引き当て（replyOf）にも掛かる', async () => {
  let got: FeedRow[] = []
  let rev = ''
  for (let i = 0; i < 100 && got.length === 0; i++) {
    const d = await detail('OLD')
    got = d.rows.filter((r) => r.recovered)
    if (i === 0) rev = d.rev
    if (got.length === 0) await new Promise((r) => setTimeout(r, 50))
  }
  assert.equal(got.length, 1)
  assert.equal(got[0]!.text, '#583 は PR #610 です')
  const d = await detail('OLD')
  assert.notEqual(d.rev, rev === d.rev ? '' : rev, '補った行が増えたら rev が変わる（画面が取り直す）')
  assert.deepEqual(d.rows.map((r) => [r.event, Boolean(r.recovered)]), [['UserPromptSubmit', false], ['Stop', true], ['UserPromptSubmit', false], ['Stop', false]], '落ちたところに入る')
  assert.equal(replyOf(d.rows, 'OLD@repo', 'abcdef0123456789')?.text, '#583 は PR #610 です', 'セッション同士のメッセージの返答として引ける')
  assert.equal(d.session.turns, 1)
})

test('ターン完了の行の本文が空: 同じ行に本文を載せる（行は増やさない）', async () => {
  const d = await detail('EMPTY')
  assert.equal(d.rows.length, 2)
  assert.deepEqual([d.rows[1]!.event, d.rows[1]!.text, d.rows[1]!.recovered], ['Stop', 'PR #621 を出しました', true])
  assert.equal(d.session.last_text, 'PR #621 を出しました')
  assert.equal(d.session.turns, 1)
})

test('補わない: まだ回っている・閉じたのは前のターン・閉じないまま次へ進んだ・別のマシン・transcript が無い', async () => {
  for (const id of ['RUNNING', 'EARLIER', 'REMOTE', 'NOFILE']) assert.deepEqual(await recoveredOf(id), [], id)
  // 裏で読むぶん（古いターン）が終わるのを少し待ってから見る
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(await recoveredOf('STOPPED'), [], '途中の地の文を返答として出さない')
  assert.equal(await readFile(feedFile, 'utf-8'), feedBefore)
})

test('一覧: 補った返答のあとに「入力待ち」の行が来ていても最後の発言になる。前の待ち（許可）は畳む（#627 のレビュー）', async () => {
  const list = (await (await fetch(`${base}/api/sessions?days=2`)).json()) as SessionsResponse
  const idle = list.sessions.find((x) => x.id === 'IDLE@repo')!
  assert.equal(idle.last_text, 'PR #622 を出しました', '最後の行（入力待ち）ではなく、最後のターン完了と比べる')
  assert.equal(idle.last_kind, 'idle', '最後の行の読み方は記録のまま')
  assert.equal(idle.turns, 1)
  const asked = list.sessions.find((x) => x.id === 'ASKED@repo')!
  assert.deepEqual([asked.last_text, asked.last_kind, asked.waiting], ['PR #623 を出しました', 'turn', ''], '終わったターンの許可待ちを「待機中」のまま残さない')
})
