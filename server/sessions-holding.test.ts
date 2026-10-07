// sai_sessions の 1 行に「いま何を持っているか」を足す（#727 の案 D の読む側）。SAI が渡す口（/api/agent/sessions）と
// tailnet の口（/mcp）の両方を、本物の createApp で見る。PR を読む口（PrBrowser）は差し替えるので gh は叩かない
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliveredText } from '../shared/agentMessages.ts'
import type { AgentSendResponse, AgentSessionsResponse, PrSummary, Replying } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { Authenticator } from './auth.ts'
import { NoPrs } from './git/prs.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import { AGENT_TOKEN_FILE } from './reply/agentMessages.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'

let dir: string
/** セッションの cwd（置き場の下にすると、SAI 自身の雑音として読み飛ばされる） */
let work: string
let server: Server
let base: string
let token: string
let feedFile: string

class FakeRunner implements Runner {
  started: { id: string; cmd: ReplyCommand }[] = []
  busy = new Map<string, Replying>()
  running(id: string) {
    const r = this.busy.get(id)
    return r !== undefined && !r.failed
  }
  snapshot() {
    return Object.fromEntries(this.busy)
  }
  async start(id: string, cmd: ReplyCommand) {
    this.started.push({ id, cmd })
  }
}
const runner = new FakeRunner()

const pr = (number: number, head: string, over: Partial<PrSummary> = {}): PrSummary => ({
  number, title: `題名は出さない (#${number - 1})`, author: 'me', head, base: 'main', draft: false, updated_at: '', url: '',
  additions: 0, deletions: 0, changed_files: 0, review_decision: '', checks: 'success', requested: false, ...over,
})
/** PR を読む口の偽物。`cached()` は前の結果を待たずに返し、`list()` は呼ばれた回数と、わざと遅い応答を持つ */
class FakePrs extends NoPrs {
  override readonly available = true as unknown as false
  lists = new Map<string, PrSummary[] | null>()
  asked: string[] = []
  slow = false
  /** 前の結果が何ミリ秒前のものか（既定は新しい） */
  age = 0
  cached(repo: string, maxAgeMs = Infinity): PrSummary[] | null | undefined {
    return this.age <= maxAgeMs ? this.lists.get(repo) : undefined
  }
  override list(repo?: string): Promise<PrSummary[] | null> {
    this.asked.push(repo ?? '')
    return this.slow ? new Promise(() => {}) : Promise.resolve(this.lists.get(repo ?? '') ?? null)
  }
}
const prs = new FakePrs()

const now = new Date()
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000)
const REMOTE = 'https://github.com/o/repo-x'

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-holding-'))
  work = await mkdtemp(join(tmpdir(), 'sai-holding-work-'))
  feedFile = join(dir, `${localDate(now.toISOString())}.jsonl`)
  const base0 = { repo: 'r', cwd: work, project: 'o/repo-x', remote: REMOTE }
  await writeFile(
    feedFile,
    [
      row(minutesAgo(9), 'A1', { ...base0, branch: 'main', user_text: '割り振って' }),
      row(minutesAgo(8), 'B1', { ...base0, branch: 'issue-9100-stock-filter', user_text: '直して', text: '直しました' }),
      row(minutesAgo(7), 'C1', { ...base0, branch: 'dev-worktree-c', user_text: '見て', text: '見ました' }),
      // 記録に remote の無いセッション（どのリポジトリか分からない）
      row(minutesAgo(6), 'D1', { repo: 'r', cwd: work, project: 'o/repo-x', branch: 'issue-9300-x', user_text: '見て', text: '見ました' }),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  const app = createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    runner,
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async () => null),
    { tmux: { run: async () => { throw new Error('unused') } }, ps: async () => '' },
    undefined,
    { run: async () => { throw new Error('unused') } },
    undefined,
    undefined,
    undefined,
    undefined,
    prs,
  )
  token = (await readFile(join(dir, AGENT_TOKEN_FILE), 'utf-8')).trim()
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

const agent = (path: string, init: { method?: string; body?: string } = {}) =>
  fetch(base + path, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', 'X-SAI-Agent-Token': token }, ...(init.body ? { body: init.body } : {}) })
/** SAI が渡す口の sai_sessions（送り元 A1 がターンを回している間だけ呼べる） */
const sessionsFor = async () => {
  runner.busy.set('A1@r', { since: `${Date.now()}-${Math.random()}`, text: 'やって' })
  try {
    const res = await agent('/api/agent/sessions?from=A1%40r')
    assert.equal(res.status, 200)
    return ((await res.json()) as AgentSessionsResponse).sessions
  } finally {
    runner.busy.delete('A1@r')
  }
}
/** tailnet の口（ループバック）の sai_sessions の、そのセッションの 1 行 */
const mcpLine = async (id: string) => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sai_sessions', arguments: {} } }),
  })
  assert.equal(res.status, 200)
  const text = ((await res.json()) as { result: { content: { text: string }[] } }).result.content.map((c) => c.text).join('\n')
  return text.split('\n').find((l) => l.startsWith(`- ${id}`)) ?? ''
}

test('sai_sessions: ブランチから出ている open な PR と CI・ブランチ名と PR の題名から引けた issue・空きを足す。本文・題名は足さない（#727）', async () => {
  prs.lists.set('o/repo-x', [pr(9101, 'issue-9100-stock-filter', { checks: 'failure' }), pr(9400, 'someone-else')])
  const list = await sessionsFor()
  const of = (id: string) => list.find((s) => s.id === id)?.holding
  assert.deepEqual(of('B1@r'), { pr: { number: 9101, checks: 'failure' }, issues: [9100], free: true })
  assert.deepEqual(of('C1@r'), { free: true }, '番号の無いブランチ・PR の無いブランチは、空きだけ')
  assert.deepEqual(of('D1@r'), { issues: [9300], free: true }, 'どのリポジトリか分からなければ PR は引かない（ブランチ名の番号は出る）')
  assert.deepEqual(prs.asked, [], '前の結果があれば gh を待たない')
  // tailnet の口も同じ印
  const line = await mcpLine('B1@r')
  assert.match(line, /issue-9100-stock-filter （空き） PR #9101（CI 赤） issue #9100 最後の記録: /)
  assert.doesNotMatch(line, /題名は出さない/)
  assert.match(await mcpLine('C1@r'), /dev-worktree-c （空き） 最後の記録: /)
})

test('sai_sessions: 処理中・待ち・預かりがあれば空きではない。頼まれてまだ返していない依頼を数え、その 1 行目の番号も引く（#727）', async () => {
  // A1 が C1 に頼む（C1 のターンはまだ終わっていない）
  runner.busy.set('A1@r', { since: 'turn-1', text: 'やって' })
  let messageId = ''
  try {
    const res = await agent('/api/agent/send', { method: 'POST', body: JSON.stringify({ from: 'A1@r', to: 'C1@r', text: '#9200 に着手してください。\n関連は #1 と #2 です' }) })
    assert.equal(res.status, 202)
    messageId = ((await res.json()) as AgentSendResponse).message_id
  } finally {
    runner.busy.delete('A1@r')
  }
  // C1 はその依頼のターンを回している（いまのターンの入力が、依頼の見出しを持つ）
  runner.busy.set('C1@r', { since: 'turn-c', text: runner.started.at(-1)!.cmd.text })
  let c = (await sessionsFor()).find((s) => s.id === 'C1@r')
  assert.deepEqual(c?.holding, { issues: [9200], asked: 1 }, '処理中で、頼まれて未完。空きではない')
  assert.match(await mcpLine('C1@r'), /（処理中） issue #9200 頼まれ中 1 件 最後の記録: /)
  // 相手のターンが終わった（返答の行が届いた）→ 未完ではなくなり、空きに戻る
  runner.busy.delete('C1@r')
  const delivered = deliveredText({ label: '割り振って', project: 'o/repo-x' }, messageId, '#9200 に着手してください。')
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'C1', { repo: 'r', cwd: work, project: 'o/repo-x', remote: REMOTE, branch: 'dev-worktree-c', user_text: delivered, text: 'PR を出しました' })) + '\n')
  c = (await sessionsFor()).find((s) => s.id === 'C1@r')
  assert.deepEqual(c?.holding, { free: true })
})

test('sai_sessions: PR をまだ 1 回も引いていないリポジトリは短く待つだけで、引けなくても行は落とさない（#727）', async () => {
  prs.lists.clear()
  prs.asked.length = 0
  prs.slow = true
  const started = Date.now()
  const list = await sessionsFor()
  assert.ok(Date.now() - started < 4000, '応答を gh に待たせない')
  assert.deepEqual(prs.asked, ['o/repo-x'], 'リポジトリごとに 1 回だけ聞く（セッションの数だけ聞かない）')
  assert.deepEqual(list.find((s) => s.id === 'B1@r')?.holding, { issues: [9100], free: true }, 'PR の印が付かないだけ')
  assert.equal(list.length, 3)
  // 前の結果が古すぎるときも「いま」として出さず、同じように短く待つ（何時間も前の CI を今の状態として出さない）
  prs.lists.set('o/repo-x', [pr(9101, 'issue-9100-stock-filter', { checks: 'failure' })])
  prs.age = 60 * 60_000
  prs.asked.length = 0
  assert.deepEqual((await sessionsFor()).find((s) => s.id === 'B1@r')?.holding, { issues: [9100], free: true })
  assert.deepEqual(prs.asked, ['o/repo-x'])
  prs.age = 0
  prs.slow = false
})

test('sai_sessions: 失敗した・止められた依頼（返答が来ないまま、相手がもう回っていない）は頼まれ中に数えない（#727 のレビュー）', async () => {
  runner.busy.set('A1@r', { since: 'turn-2', text: 'やって' })
  try {
    assert.equal((await agent('/api/agent/send', { method: 'POST', body: JSON.stringify({ from: 'A1@r', to: 'B1@r', text: '#9500 に着手してください。' }) })).status, 202)
  } finally {
    runner.busy.delete('A1@r')
  }
  // 相手のターンは起動されたが、返答の行を残さずに終わった（失敗・人が止めた）。相手はもう回っていない
  const b = (await sessionsFor()).find((s) => s.id === 'B1@r')
  assert.equal(b?.holding?.asked, undefined)
  assert.deepEqual(b?.holding?.issues, [9100], '死んだ依頼の番号も持ち越さない')
  assert.equal(b?.holding?.free, true)
  // 相手が**別の**ターンを回している間も、死んだ依頼は生き返らない（空きではないだけ）
  runner.busy.set('B1@r', { since: 'turn-b', text: '人からの別の指示' })
  const busy = (await sessionsFor()).find((s) => s.id === 'B1@r')
  runner.busy.delete('B1@r')
  assert.deepEqual([busy?.holding?.issues, busy?.holding?.asked, busy?.holding?.free], [[9100], undefined, undefined])
})

