// daemon で許可・質問を受ける（#848 の 3）の app 側。本物の createApp に偽の口を渡す。本物のソケット・本物の端末には触らない
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Approval, ApprovalAnswer, ApprovalMap, CodexConfigAsk, Replying, SessionSummary, SessionsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { Authenticator } from './auth.ts'
import { FakeWorkGit } from './git/workStateFake.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import type { CodexConfigGate } from './reply/codexConfigGuard.ts'
import type { CodexDaemonWatch, DaemonAnswerResult } from './reply/codexDaemon.ts'
import type { CodexDialogSource } from './reply/codexDialogs.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'

let dir: string
let work: string
let server: Server
let base: string

class FakeRunner implements Runner {
  busy = new Map<string, Replying>()
  running(id: string) {
    return this.busy.has(id)
  }
  snapshot() {
    return Object.fromEntries(this.busy)
  }
  async start(_id: string, _cmd: ReplyCommand) {}
}

const approvalOf = (approvalId: string, entity: string, text: string): Approval => ({
  approval_id: approvalId,
  id: entity,
  since: new Date().toISOString(),
  tool_name: 'CodexCommand',
  input: {},
  tool_use_id: 'item-1',
  text,
  agent: 'codex',
  answerable: true,
  decisions: [{ id: 'd0', label: '許可', behavior: 'allow' }, { id: 'd1', label: '拒否', behavior: 'deny' }],
})

/** 偽の daemon。呼ばれた順を覚える */
class FakeDaemon implements CodexDaemonWatch {
  listener: ((threadId: string) => void) | null = null
  resumed = new Map<string, string>()
  resumeCalls: string[] = []
  answers: { approvalId: string; answer: ApprovalAnswer }[] = []
  pending = new Map<string, Approval>()
  quiet = new Set<string>()
  settling() {
    return new Set(this.quiet)
  }
  setEnabled() {}
  link() {
    return 'connected' as const
  }
  state() {
    return undefined
  }
  stop() {}
  onWaiting(listener: (threadId: string) => void) {
    this.listener = listener
  }
  async resume(threadId: string, entity: string) {
    this.resumeCalls.push(`${threadId}=${entity}`)
    this.resumed.set(threadId, entity)
    return true
  }
  released: string[] = []
  release(threadId: string) {
    this.released.push(threadId)
    this.resumed.delete(threadId)
  }
  snapshot(): ApprovalMap {
    const out: ApprovalMap = {}
    for (const a of this.pending.values()) (out[a.id] ??= []).push(a)
    return out
  }
  getApproval(approvalId: string) {
    return this.pending.get(approvalId)
  }
  answer(approvalId: string, answer: ApprovalAnswer): DaemonAnswerResult {
    if (!this.pending.has(approvalId)) return { ok: false, status: 404, error: 'approval not found' }
    this.answers.push({ approvalId, answer })
    this.pending.delete(approvalId)
    return { ok: true }
  }
}

/** 偽の端末の画面の読み取り。渡されたセッションごとにダイアログを 1 つ出す */
class FakeDialogs implements CodexDialogSource {
  scanned: string[][] = []
  async scan(sessions: SessionSummary[]): Promise<ApprovalMap> {
    this.scanned.push(sessions.map((s) => s.id))
    const out: ApprovalMap = {}
    for (const s of sessions) if (s.agent === 'codex') out[s.id] = [approvalOf(`dialog-${s.id}`, s.id, '端末のダイアログ')]
    return out
  }
  has(approvalId: string) {
    return approvalId.startsWith('dialog-')
  }
}

const daemon = new FakeDaemon()
const dialogs = new FakeDialogs()
let configAsk: CodexConfigAsk | null = null
const configChecked: string[] = []
const codexConfig: CodexConfigGate = {
  check: async (cwd) => {
    configChecked.push(cwd)
    return configAsk
  },
  allow: async () => null,
}

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-daemon-approvals-'))
  work = await mkdtemp(join(tmpdir(), 'sai-daemon-approvals-work-'))
  const now = new Date()
  const base0 = { repo: 'r', cwd: work, project: 'o/repo-x', agent: 'codex' as const, session_source: 'rollout' as const }
  await writeFile(
    join(dir, `${localDate(now.toISOString())}.jsonl`),
    [
      row(new Date(now.getTime() - 10 * 60_000), 'X1', { ...base0, repo: 'r2', user_text: '前の worktree', text: 'はい' }),
      row(new Date(now.getTime() - 9 * 60_000), 'X1', { ...base0, user_text: '見て', text: '見ました' }),
      row(new Date(now.getTime() - 8 * 60_000), 'X2', { ...base0, user_text: '直して', text: '直しました' }),
      row(new Date(now.getTime() - 7 * 60_000), 'R1', { ...base0, host: 'othermac', user_text: '別のマシン', text: 'はい' }),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  const app = createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    new FakeRunner(),
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async () => null),
    { tmux: { run: async () => { throw new Error('unused') } }, ps: async () => '', codexDaemon: daemon, codexDialogs: dialogs, codexConfig },
    undefined,
    new FakeWorkGit(),
  )
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

const wait = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 5))
  assert.ok(ok(), '待ち切れなかった')
}

const approvalsNow = async () => ((await (await fetch(`${base}/api/sessions`)).json()) as SessionsResponse).approvals ?? {}
const answer = (approvalId: string, body: object, origin = base) =>
  fetch(`${base}/api/approvals/${approvalId}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) })

test('待ちになったスレッドは .codex/ の確かめを通してから resume し、止まれば resume しない。行の無い・別のマシンのスレッドも resume しない（#848 の 3）', async () => {
  assert.ok(daemon.listener, 'onWaiting を登録する')
  configAsk = { reason: 'found', files: ['sub/.codex/config.toml'], more: 0, note: '', fingerprint: 'f' } as CodexConfigAsk
  daemon.listener!('X2')
  await wait(() => configChecked.length === 1)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(daemon.resumeCalls, [], '確かめで止まったら resume しない')
  assert.deepEqual(daemon.released, ['X2'], '受けるのをやめる（resume 済みでも、確かめ直しが通らなければ）')
  assert.equal(configChecked[0], work)

  configAsk = null
  daemon.listener!('NOPE')
  daemon.listener!('R1')
  await new Promise((r) => setTimeout(r, 30))
  await wait(() => daemon.released.length === 3)
  assert.deepEqual(daemon.resumeCalls, [], '行の無いスレッド・別のマシンのセッションは resume しない')
  assert.deepEqual(daemon.released, ['X2', 'NOPE', 'R1'])
  assert.equal(configChecked.length, 1, '確かめにも行かない')

  daemon.listener!('X1')
  await wait(() => daemon.resumeCalls.length === 1)
  daemon.resumed.clear()
  assert.deepEqual(daemon.resumeCalls, ['X1=X1@r'])
  assert.equal(configChecked.length, 2, 'resume の前に確かめる')
})

test('daemon が許可を預かっている間だけ端末の画面の読み取りから外し、daemon の許可だけを出す。答えは daemon に渡す（#848 の 3）', async () => {
  daemon.resumed.set('X1', 'X1@r')
  const held = await approvalsNow()
  assert.deepEqual(held['X1@r']?.map((a) => a.approval_id), ['dialog-X1@r'], 'resume していても、預かりが無ければ画面の読み取りのまま（daemon で受けない種類のダイアログ）')
  daemon.pending.set('dmn-1', approvalOf('dmn-1', 'X1@r', 'daemon の許可'))
  const shown = await approvalsNow()
  assert.ok(!dialogs.scanned.at(-1)!.includes('X1@r'), '画面の読み取りに渡さない')
  assert.ok(!dialogs.scanned.at(-1)!.includes('X1@r2'), '同じスレッドの別のリポジトリの行も渡さない')
  assert.equal(shown['X1@r2'], undefined)
  assert.ok(dialogs.scanned.at(-1)!.includes('X2@r'), 'ほかの Codex はこれまでどおり')
  assert.deepEqual(shown['X1@r']?.map((a) => a.approval_id), ['dmn-1'], '二重に出さない')
  assert.deepEqual(shown['X2@r']?.map((a) => a.approval_id), ['dialog-X2@r'])

  assert.equal((await answer('dmn-1', { behavior: 'allow', decision: 'd0' }, 'http://evil.example')).status, 403, '同一オリジンのみ')
  assert.equal((await answer('dmn-1', { behavior: 'allow', decision: 'd0', remember: 'local' })).status, 400, '常に許可のルールは書かない')
  assert.equal(daemon.answers.length, 0)
  const ok = await answer('dmn-1', { behavior: 'allow', decision: 'd0' })
  assert.equal(ok.status, 200)
  assert.deepEqual(daemon.answers, [{ approvalId: 'dmn-1', answer: { behavior: 'allow', decision: 'd0' } }])
  assert.equal((await answer('dmn-1', { behavior: 'allow', decision: 'd0' })).status, 404, '二度は答えない')

  // 畳んだ直後は、TUI のダイアログが閉じるまで画面の読み取りを抑える
  daemon.quiet.add('X1')
  assert.equal((await approvalsNow())['X1@r'], undefined, '畳んだ直後は画面の文字から出し直さない')
  daemon.quiet.clear()
  // 預かりが無くなったら（答えた・TUI で答えられた・切れた）、画面の読み取りに戻す
  const back = await approvalsNow()
  assert.deepEqual(back['X1@r']?.map((a) => a.approval_id), ['dialog-X1@r'])
  daemon.resumed.clear()
})
