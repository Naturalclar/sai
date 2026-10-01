// ターン完了の行が落ちたセッションの印（#614）。本物の createApp と本物の ProgressReader に、作った transcript を読ませる。
// 分かるとき（transcript でターンが閉じているのに、記録の最後が人の入力のまま）だけ載り、行・未読・turns は動かないことを見る
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
import { claudeProjectName } from '../shared/progress.ts'
import type { SessionDetailResponse, SessionsResponse } from '../shared/types.ts'

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
const input = (session: string, over: Record<string, unknown> = {}) => row(ago(10), session, { repo: 'repo', cwd: dir, agent: 'claude', event: 'UserPromptSubmit', user_text: 'PR を出して', text: '', ...over })

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-stop-missing-'))
  const feedDir = join(dir, 'feed')
  const projectDir = join(dir, 'projects', claudeProjectName(dir))
  await mkdir(feedDir)
  await mkdir(projectDir, { recursive: true })
  const closed = [user(ago(10), 'PR を出して'), said(ago(5), 'PR #610 を出しました', 'end_turn')].join('\n') + '\n'
  // 落ちた: ターンは 5 分前に閉じているのに、記録の最後は 10 分前の入力のまま。
  // **返答の本文が transcript に無い**（考えただけで閉じた）ので補えない = 印だけが出る。本文があれば補う（recovered-turns.test.ts）
  const thought = JSON.stringify({ type: 'assistant', timestamp: ago(5).toISOString(), message: { role: 'assistant', content: [{ type: 'thinking', thinking: '…' }], stop_reason: 'end_turn' } })
  await writeFile(join(projectDir, 'DROPPED.jsonl'), [user(ago(10), 'PR を出して'), thought].join('\n') + '\n')
  // まだ回っている（ツールの途中）
  await writeFile(join(projectDir, 'RUNNING.jsonl'), [user(ago(10), 'PR を出して'), tool(ago(9))].join('\n') + '\n')
  // 端末で Esc で止めた（閉じていない）
  await writeFile(join(projectDir, 'STOPPED.jsonl'), [user(ago(10), 'PR を出して'), tool(ago(9)), user(ago(8), '[Request interrupted by user]')].join('\n') + '\n')
  // ターン完了の行が来ている
  await writeFile(join(projectDir, 'DONE.jsonl'), closed)
  // 別のマシンのセッション（同じ ID の transcript がこちらにあっても読まない）
  await writeFile(join(projectDir, 'REMOTE.jsonl'), closed)
  await writeFile(join(projectDir, 'MOVED.jsonl'), closed)
  // 閉じたばかり（フックの行を待つ）
  await writeFile(join(projectDir, 'JUST.jsonl'), [user(ago(10), 'PR を出して'), said(new Date(now.getTime() - 5_000), 'できました', 'end_turn')].join('\n') + '\n')
  // 閉じたのは前のターン（入力はそのあと）
  await writeFile(join(projectDir, 'EARLIER.jsonl'), [user(ago(30), '前の指示'), said(ago(20), '前の返答', 'end_turn')].join('\n') + '\n')
  const lines = [
    input('DROPPED'),
    input('RUNNING'),
    input('STOPPED'),
    input('DONE'),
    row(ago(5), 'DONE', { repo: 'repo', cwd: dir, agent: 'claude', user_text: 'PR を出して', text: 'PR #610 を出しました' }),
    input('REMOTE', { host: 'far-away-machine' }),
    input('JUST'),
    input('EARLIER'),
    input('NOFILE'),
    // ターンの途中で別の worktree に移り、ターン完了の行はそちらのエンティティに載った
    input('MOVED'),
    row(ago(5), 'MOVED', { repo: 'other', cwd: dir, agent: 'claude', user_text: 'PR を出して', text: 'PR #610 を出しました' }),
  ]
  feedFile = join(feedDir, `${localDate(now.toISOString())}.jsonl`)
  feedBefore = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  await writeFile(feedFile, feedBefore)
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

test('一覧と詳細: transcript でターンが閉じているのに記録の最後が人の入力のまま（返答も補えない）セッションにだけ stop_missing が載る（#614）', async () => {
  const list = (await (await fetch(`${base}/api/sessions?days=2`)).json()) as SessionsResponse
  const flagged = list.sessions.filter((s) => s.stop_missing).map((s) => s.id)
  assert.deepEqual(flagged, ['DROPPED@repo'], '回っている・Esc で止めた・完了の行がある（別の worktree のエンティティでも）・別のマシン・閉じたばかり・前のターン・transcript が無い、は出さない')

  const dropped = list.sessions.find((s) => s.id === 'DROPPED@repo')!
  assert.equal(dropped.turns, 0, 'turns は進めない（数えるのはターン完了の行だけ）')
  assert.equal(dropped.unread, undefined, '補えなければ未読も進まない')
  assert.equal(dropped.waiting, '', '待ちにもしない（要対応に数えない）')

  const detail = (await (await fetch(`${base}/api/sessions/${encodeURIComponent('DROPPED@repo')}`)).json()) as SessionDetailResponse
  assert.equal(detail.session.stop_missing, true, '詳細（見出し）にも載る')
  assert.equal(detail.rows.length, 1, '補える本文が無ければ行は足さない')
  assert.equal(await readFile(feedFile, 'utf-8'), feedBefore, 'SAI は JSONL に行を書かない')
})
