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
import type { AgentSendResponse, AgentSessionsResponse, PrSummary, Replying, SessionDetailResponse } from '../shared/types.ts'
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
import { FAKE_HEAD, FakeWorkGit } from './git/workStateFake.ts'
import { mergedKey } from './git/prs.ts'
import type { AgentList, ClaudeAgent } from './local/claudeAgents.ts'
import { startRefusal } from '../shared/holding.ts'

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
  /** マージ済みの PR の head（#795。`mergedKey()` の集合）。null は引けない */
  merged: Set<string> | null = new Set()
  mergedHeads(): Promise<ReadonlySet<string> | null> {
    return Promise.resolve(this.merged)
  }
  /** コミットの親（#821。SHA → 親の並び）。置いていないものは引けない。`parentsSlow` は返らない */
  parents = new Map<string, string[]>()
  parentsAsked: string[] = []
  parentsSlow = false
  commitParents(_repo: string, sha: string): Promise<readonly string[] | null> {
    this.parentsAsked.push(sha)
    return this.parentsSlow ? new Promise(() => {}) : Promise.resolve(this.parents.get(sha) ?? null)
  }
  override list(repo?: string): Promise<PrSummary[] | null> {
    this.asked.push(repo ?? '')
    return this.slow ? new Promise(() => {}) : Promise.resolve(this.lists.get(repo ?? '') ?? null)
  }
}
const prs = new FakePrs()
/** `claude --bg` の行の偽物（#795）。セッションの生の ID → 行。この Mac の `claude agents` は起こさない */
const bgRows = new Map<string, ClaudeAgent>()
const claudeAgents: AgentList = { busy: async () => undefined, background: async (id) => bgRows.get(id) ?? null }
/** worktree の作りかけ（#795）。置いていない cwd は git のリポジトリでない扱い */
const git = new FakeWorkGit()

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
    git,
    undefined,
    undefined,
    undefined,
    claudeAgents,
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
  assert.deepEqual(of('B1@r'), { pr: { number: 9101, checks: 'failure' }, issues: [9100], why: 'pr' }, 'ブランチの PR がマージ前なら空きではない（#816）')
  assert.deepEqual(of('C1@r'), { free: true }, '番号の無いブランチ・PR の無いブランチは、空きだけ')
  assert.deepEqual(of('D1@r'), { issues: [9300], free: true }, 'どのリポジトリか分からなければ PR は引かない（ブランチ名の番号は出る）')
  assert.deepEqual(prs.asked, [], '前の結果があれば gh を待たない')
  // tailnet の口も同じ印
  const line = await mcpLine('B1@r')
  assert.match(line, /issue-9100-stock-filter PR #9101（CI 赤） issue #9100 （PR がマージ前） 最後のターン: \d+ 分前 最後の記録: /)
  assert.doesNotMatch(line, /題名は出さない/)
  assert.match(await mcpLine('C1@r'), /dev-worktree-c （空き） 最後のターン: \d+ 分前 最後の記録: /)
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
  assert.deepEqual(c?.holding, { issues: [9200], asked: 1, why: 'busy' }, '処理中で、頼まれて未完。空きではない')
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
  // 相手の PR はマージされた（open な PR に無い）。マージ前の PR があると着手の依頼が通らない（#816）
  prs.lists.set('o/repo-x', [])
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


// ---- #795: 作りかけのある相手を空きにしない・送る時点で確かめる

const sendStart = async (to: string, text: string) => {
  runner.busy.set('A1@r', { since: `turn-${Math.random()}`, text: 'やって' })
  try {
    return await agent('/api/agent/send', { method: 'POST', body: JSON.stringify({ from: 'A1@r', to, text }) })
  } finally {
    runner.busy.delete('A1@r')
  }
}

test('sai_sessions: コミットしていない変更・PR になっていないコミットがあれば空きにしない。マージ済みのブランチが残っているだけは空き。git が読めなければ空きにしない（#795）', async () => {
  prs.lists.set('o/repo-x', [pr(9101, 'issue-9100-stock-filter')])
  const holdingOfId = async (id: string) => (await sessionsFor()).find((s) => s.id === id)?.holding
  try {
    git.states.set(work, 'dirty')
    assert.deepEqual(await holdingOfId('B1@r'), { pr: { number: 9101, checks: 'success' }, issues: [9100], why: 'dirty' }, 'PR が出ていても、未コミットの変更があれば空きではない')
    assert.match(await mcpLine('C1@r'), /dev-worktree-c （未コミットの変更） /)
    git.states.set(work, 'ahead')
    assert.deepEqual(await holdingOfId('B1@r'), { pr: { number: 9101, checks: 'success' }, issues: [9100], why: 'pr' }, 'open な PR になっているコミットは、PR がマージされるまで空きではない（#816）')
    assert.deepEqual(await holdingOfId('C1@r'), { why: 'unpushed' })
    assert.match(await mcpLine('C1@r'), /dev-worktree-c （PR 前のコミット） /)
    // マージ済みの PR の head がいまの HEAD そのものなら、残っているだけのブランチ（main がそのファイルをあとで変えていても）
    prs.merged = new Set([mergedKey('dev-worktree-c', FAKE_HEAD)])
    assert.deepEqual(await holdingOfId('C1@r'), { free: true }, 'マージ済みのブランチが残っているだけ（PR の head と同じ）')
    prs.merged = new Set([mergedKey('dev-worktree-c', 'b'.repeat(40))])
    assert.deepEqual(await holdingOfId('C1@r'), { why: 'unpushed' }, 'マージのあとにコミットが足されている')
    // GitHub 上で base を取り込んでからマージされた（#821）: head は手元の HEAD を 1 つ目の親に持つマージコミット
    const update = 'c'.repeat(40)
    const base = 'd'.repeat(40)
    prs.merged = new Set([mergedKey('dev-worktree-c', update), mergedKey('dev-worktree-x', 'e'.repeat(40))])
    prs.parents.set(update, [FAKE_HEAD, base])
    prs.parentsAsked = []
    assert.deepEqual(await holdingOfId('C1@r'), { free: true }, 'GitHub が作った取り込みのコミットだけが手元に無い')
    assert.deepEqual(prs.parentsAsked, [update], '親を引くのは同じブランチのマージ済みの head だけ')
    prs.parents.set(update, [base, FAKE_HEAD])
    assert.deepEqual(await holdingOfId('C1@r'), { why: 'unpushed' }, 'いまの HEAD が 2 つ目の親（別のブランチに取り込まれた側）')
    prs.parents.set(update, [FAKE_HEAD])
    assert.deepEqual(await holdingOfId('C1@r'), { why: 'unpushed' }, 'いまの HEAD の上に、別の所から足されたただのコミット')
    prs.parents.set(update, ['b'.repeat(40), base])
    assert.deepEqual(await holdingOfId('C1@r'), { why: 'unpushed' }, '親が手元の HEAD と関係ない')
    prs.parents.delete(update)
    assert.deepEqual(await holdingOfId('C1@r'), { why: 'unpushed' }, '親が引けなければ、空きにしない')
    prs.parents.set(update, [FAKE_HEAD, base])
    prs.parentsSlow = true
    try {
      assert.deepEqual(await holdingOfId('C1@r'), { why: 'unpushed' }, '親が時間内に返らなければ、空きにしない')
    } finally {
      prs.parentsSlow = false
    }
    prs.lists.set('o/repo-x', [pr(9101, 'issue-9100-stock-filter'), pr(9102, 'dev-worktree-c')])
    prs.parentsAsked = []
    assert.equal((await holdingOfId('C1@r'))?.why, 'pr', 'open な PR があれば、今までどおりマージ前')
    assert.deepEqual(prs.parentsAsked, [], 'open な PR があれば親を引かない')
    prs.lists.set('o/repo-x', [pr(9101, 'issue-9100-stock-filter')])
    prs.parents.clear()
    prs.merged = null
    assert.deepEqual(await holdingOfId('C1@r'), { why: 'unpushed' }, 'マージ済みの一覧が引けなければ、空きにしない')
    prs.merged = new Set()
    git.states.set(work, 'merged')
    assert.deepEqual(await holdingOfId('C1@r'), { free: true }, 'マージ済みのブランチが残っているだけ（中身が base と同じ。gh が無くても分かる）')
    git.states.set(work, 'unknown')
    assert.deepEqual(await holdingOfId('C1@r'), { why: 'unknown' })
    assert.match(await mcpLine('C1@r'), /（状態不明）/)
    git.states.set(work, 'clean')
    assert.deepEqual(await holdingOfId('C1@r'), { free: true })
  } finally {
    git.states.delete(work)
    prs.lists.clear()
  }
})

test('sai_send: 着手の形の依頼は、送る時点で相手が空きでなければ送らずに理由を返す。一覧の印と同じ答え。着手の形でなければ今までどおり送る（#795）', async () => {
  try {
    for (const state of ['dirty', 'ahead', 'unknown'] as const) {
      git.states.set(work, state)
      const why = (await sessionsFor()).find((s) => s.id === 'C1@r')?.holding?.why
      assert.ok(why, state)
      const runs = runner.started.length
      const res = await sendStart('C1@r', '#9600 に着手してください。\n本文と全コメントが正本です。')
      assert.equal(res.status, 409, state)
      assert.equal(((await res.json()) as { error: string }).error, startRefusal(why), '一覧に出した理由と、断りの文の理由が同じ')
      assert.equal(runner.started.length, runs, '相手には何もしない')
    }
    // 着手の形でない依頼は確かめない（今までどおり）
    git.states.set(work, 'dirty')
    const runs = runner.started.length
    assert.equal((await sendStart('C1@r', 'いまの PR の状況を教えてください。')).status, 202)
    assert.equal(runner.started.length, runs + 1)
  } finally {
    git.states.delete(work)
  }
})

test('sai_sessions: 止められない claude --bg（ターン中）が掴んでいるセッションは空きにしない。止まった bg は空きのまま（#795）', async () => {
  const row0 = { sessionId: 'C1', id: 'abcd1234', kind: 'background', status: 'busy', state: '', cwd: work, pid: 0, name: '' }
  try {
    bgRows.set('C1', row0)
    const held = (await sessionsFor()).find((s) => s.id === 'C1@r')?.holding
    assert.deepEqual(held, { why: 'background' })
    assert.match(await mcpLine('C1@r'), /（裏で動作中）/)
    const res = await sendStart('C1@r', '#9700 に着手してください。')
    assert.equal(res.status, 409)
    assert.equal(((await res.json()) as { error: string }).error, startRefusal('background'))
    // 止まった bg（誰も開いておらず、ターンも回っていない）は、送るときに SAI が止めて続けられるので空き
    bgRows.set('C1', { ...row0, status: '', state: 'stopped' })
    assert.deepEqual((await sessionsFor()).find((s) => s.id === 'C1@r')?.holding, { free: true })
  } finally {
    bgRows.clear()
  }
})

test('預かった着手の依頼（1 ターンの回数を超えた分）: 相手が空きなら、送り元のターンが終わってから届く。自分自身を「頼まれ中」に数えて止めない。空きでなくなっていたら送らずに止めて残す（#795 のレビュー）', async () => {
  const detail = async () => ((await (await fetch(`${base}/api/sessions/${encodeURIComponent('A1@r')}`)).json()) as SessionDetailResponse).agent
  const post = (to: string, text: string) => agent('/api/agent/send', { method: 'POST', body: JSON.stringify({ from: 'A1@r', to, text }) })
  runner.busy.set('A1@r', { since: 'turn-held', text: 'やって' })
  let held: AgentSendResponse[] = []
  try {
    // その場で送れる 3 回を使い切る（着手の形でない依頼）
    for (const n of [1, 2, 3]) assert.equal((await post('D1@r', `状況を教えてください ${n}`)).status, 202)
    // 4 件目からは預かる。預かる時点では 2 人とも空き
    held = [
      (await (await post('B1@r', '#9801 に着手してください。')).json()) as AgentSendResponse,
      (await (await post('C1@r', '#9802 に着手してください。')).json()) as AgentSendResponse,
    ]
    assert.deepEqual(held.map((h) => h.held), [true, true])
    // 1 つの依頼（items）の中で、着手の依頼と別の依頼を同じ相手に重ねると、1 件も送らず・預からずに断る
    const twice = await agent('/api/agent/send', { method: 'POST', body: JSON.stringify({ from: 'A1@r', items: [{ to: 'D1@r', text: '#9803 に着手してください。' }, { to: 'D1@r', text: '補足です。' }] }) })
    assert.equal(twice.status, 409)
    assert.match(((await twice.json()) as { error: string }).error, /^2 件目: 同じ相手に、着手の依頼とほかの依頼を 1 度に送れません/)
    // 同じ相手宛ての、着手の形でない続きの 1 件も預かる（別々の送信なら預かれる）。これが後ろにあっても、前の着手の依頼は止まらない
    assert.equal((((await (await post('B1@r', '補足: 本文と全コメントが正本です。')).json()) as AgentSendResponse).held), true)
  } finally {
    runner.busy.delete('A1@r')
  }
  // 送る直前に、C1 だけ別のターンを回し始めた（端末で人が始めた作業の代わり）
  runner.busy.set('C1@r', { since: 'turn-other', text: '別の作業' })
  const runs = runner.started.length
  try {
    await fetch(`${base}/api/sessions?days=7`)
    const started = runner.started.slice(runs)
    assert.equal(started.some((x) => x.id === 'C1@r'), false, '空きでない相手には何もしない')
    assert.ok(started.find((x) => x.id === 'B1@r')!.cmd.text.endsWith('#9801 に着手してください。'), '空きの相手には届く')
    const left = (await detail())?.held ?? []
    assert.equal(left.find((h) => h.message_id === held[1]!.message_id)?.halted, startRefusal('busy'), '送らなかった 1 件は、理由を付けて画面に残す')
    assert.equal(left.some((h) => h.message_id === held[0]!.message_id), false, '同じ相手宛ての後ろの預かりがあっても、前の着手の依頼は届いている')
  } finally {
    runner.busy.delete('C1@r')
    await fetch(`${base}/api/sessions/${encodeURIComponent('A1@r')}/agent/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' })
    await fetch(`${base}/api/sessions/${encodeURIComponent('A1@r')}/agent/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' })
  }
})
