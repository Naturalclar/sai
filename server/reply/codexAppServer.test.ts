import assert from 'node:assert/strict'
import test from 'node:test'
import type { ApprovalAnswer } from '../../shared/types.ts'
import { CODEX_TURN_FAILED_TTL_MS, CodexAppServer, type CodexConnection } from './codexAppServer.ts'

type Message = Record<string, unknown> & { id?: string | number; method?: string; params?: unknown }

class FakeConnection implements CodexConnection {
  sent: Message[] = []
  /** `skills/list` の応答（#402）。null ならエラーを返す */
  skillsResult: unknown = { data: [] }
  /** `thread/start` の応答（#401）。null なら thread を返さない */
  newThread: string | null = 'thread-new'
  /** `thread/fork` の応答の thread id（#405）。null なら thread を返さない */
  forked: string | null = 'thread-forked'
  /** true なら `turn/steer` を断る（#404。実測のエラーは `no active turn to steer`） */
  failSteer = false
  /** `account/rateLimits/read` の応答（#832）。null ならエラーを返す */
  rateLimitsResult: unknown = null
  private messages: ((message: Message) => void)[] = []
  private closes: ((error?: Error) => void)[] = []

  /** 応答を保留する method（#384 の「turn/start の応答前」を作る）。release() で返す */
  private held = ''
  private holding: (() => void)[] = []

  hold(method: string): void {
    this.held = method
  }

  release(): void {
    this.held = ''
    const waiting = this.holding
    this.holding = []
    for (const send of waiting) send()
  }

  send(message: Message): void {
    this.sent.push(message)
    if (message.id === undefined || !message.method) return
    if (message.method === 'skills/list') {
      const id = message.id
      const result = this.skillsResult
      queueMicrotask(() => this.emit(result === null ? { id, error: { message: '読めない' } } : { id, result }))
      return
    }
    if (message.method === 'account/rateLimits/read') {
      const id = message.id
      const result = this.rateLimitsResult
      queueMicrotask(() => this.emit(result === null ? { id, error: { message: '読めない' } } : { id, result }))
      return
    }
    if (message.method === 'turn/steer') {
      const id = message.id
      const fail = this.failSteer
      queueMicrotask(() => this.emit(fail ? { id, error: { message: 'no active turn to steer' } } : { id, result: { turnId: 'turn-1' } }))
      return
    }
    if (message.method === 'thread/fork') {
      const id = message.id
      const made = this.forked
      const from = (message.params as { threadId?: string } | undefined)?.threadId
      queueMicrotask(() => this.emit({ id, result: made ? { thread: { id: made, forkedFromId: from, path: '/x/rollout.jsonl', turns: [] }, cwd: '/repo', model: 'm' } : {} }))
      return
    }
    if (message.method === 'thread/start') {
      const id = message.id
      const made = this.newThread
      queueMicrotask(() => this.emit({ id, result: made ? { thread: { id: made } } : {} }))
      return
    }
    const result = message.method === 'turn/start'
      ? { turn: { id: 'turn-1' } }
      : message.method === 'thread/resume'
        ? { thread: { id: 'thread-1', status: { type: 'idle' } } }
        : {}
    const reply = () => this.emit({ id: message.id, result })
    if (message.method === this.held) this.holding.push(reply)
    else queueMicrotask(reply)
  }

  onMessage(listener: (message: Message) => void): void {
    this.messages.push(listener)
  }

  onClose(listener: (error?: Error) => void): void {
    this.closes.push(listener)
  }

  close(): void {
    this.disconnect()
  }

  /** app-server のプロセスの pid（#482） */
  pid(): number {
    return 9191
  }

  emit(message: Message): void {
    for (const listener of this.messages) listener(message)
  }

  disconnect(error = new Error('切断')): void {
    for (const listener of this.closes) listener(error)
  }
}

const started = async () => {
  const connection = new FakeConnection()
  const app = new CodexAppServer(async () => connection, () => Date.parse('2026-09-09T12:00:00Z'))
  await app.start({ id: 'thread-1@repo', threadId: 'thread-1', text: '続けて', cwd: '/repo', model: 'gpt-test', attachments: ['/tmp/a.png'] })
  return { app, connection }
}

test('start: initializeしてthreadをresumeし、app-serverでturnを開始する', async () => {
  const { app, connection } = await started()
  assert.deepEqual(connection.sent.map((message) => message.method), ['initialize', 'initialized', 'thread/resume', 'turn/start'])
  const resume = connection.sent.find((message) => message.method === 'thread/resume')?.params as Record<string, unknown>
  assert.equal(resume.threadId, 'thread-1')
  assert.equal(resume.approvalsReviewer, 'user')
  const start = connection.sent.find((message) => message.method === 'turn/start')?.params as { input: Record<string, unknown>[] }
  assert.deepEqual(start.input, [
    { type: 'text', text: '続けて', text_elements: [] },
    { type: 'localImage', path: '/tmp/a.png' },
  ])
  assert.equal(app.running('thread-1@repo'), true)
  assert.deepEqual(app.replying()['thread-1@repo'], { since: '2026-09-09T12:00:00.000Z', text: '続けて', interruptible: true }, 'turnId が入っていれば止められる（#384）')
})

/** 要約を投げたところまで（#837）。`thread/compact/start` の応答は `{}` で、turn id は `turn/started` で届く（実測 0.166.0） */
const compacting = async (timeoutMs?: number) => {
  const connection = new FakeConnection()
  const app = new CodexAppServer(async () => connection, () => Date.parse('2026-09-09T12:00:00Z'), timeoutMs)
  const ended: string[] = []
  app.onTurnEnd((id) => ended.push(id))
  await app.compact({ id: 'thread-1@repo', threadId: 'thread-1', cwd: '/repo' })
  return { app, connection, ended }
}
const turnStarted = { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'compact-turn', status: 'inProgress' } } }
const turnDone = (status: string, error: unknown = null, id = 'compact-turn') => ({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id, status, error } } })
const threadStatus = (type: string) => ({ method: 'thread/status/changed', params: { threadId: 'thread-1', status: { type } } })

test('compact: thread/resume してから thread/compact/start を投げ、turn/completed まで処理中にする（#837）', async () => {
  const { app, connection, ended } = await compacting()
  assert.deepEqual(connection.sent.map((message) => message.method), ['initialize', 'initialized', 'thread/resume', 'thread/compact/start'])
  assert.deepEqual(connection.sent.at(-1)?.params, { threadId: 'thread-1' })
  assert.equal(app.running('thread-1@repo'), true)
  assert.deepEqual(app.replying()['thread-1@repo'], { since: '2026-09-09T12:00:00.000Z', text: '/compact', compact: true }, '画面は「要約中」と出せる')
  connection.emit(turnStarted)
  assert.equal(app.replying()['thread-1@repo']?.interruptible, true, 'turn id が届けば止められる')
  // 実測の順番: idle が turn/completed より先に届く。ここで片付けると、要約が終わる前に本文を回す
  connection.emit(threadStatus('idle'))
  assert.equal(app.running('thread-1@repo'), true, 'idle では終わらない')
  assert.deepEqual(ended, [])
  connection.emit(turnDone('completed'))
  assert.equal(app.running('thread-1@repo'), false)
  assert.deepEqual(ended, ['thread-1@repo'], '終わりを知らせる（預かりが本文を回す）')
  assert.equal(app.replying()['thread-1@repo'], undefined, '失敗は残らない')
})

test('compact: 要約が失敗したら失敗として残す。systemError が先に届いても中身を落とさない（#837）', async () => {
  const { app, connection, ended } = await compacting()
  connection.emit(turnStarted)
  connection.emit(threadStatus('systemError'))
  assert.deepEqual(ended, [], 'systemError では終わらない')
  connection.emit(turnDone('failed', { message: '作り物の失敗' }))
  assert.deepEqual(ended, ['thread-1@repo'])
  const failed = app.replying()['thread-1@repo']?.failed
  assert.match(failed?.tail ?? '', /要約できませんでした.*作り物の失敗/)
  assert.equal(failed?.turn_error, true)
})

test('compact: 時間切れなら止めて失敗にする。要約のターンは切れないまま残さない（#837）', async () => {
  const { app, connection, ended } = await compacting(5)
  connection.emit(turnStarted)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(app.running('thread-1@repo'), false)
  assert.deepEqual(ended, ['thread-1@repo'])
  assert.match(app.replying()['thread-1@repo']?.failed?.tail ?? '', /要約できませんでした/)
  assert.deepEqual(connection.sent.at(-1)?.params, { threadId: 'thread-1', turnId: 'compact-turn' })
  assert.equal(connection.sent.at(-1)?.method, 'turn/interrupt')
})

test('compact: 終わったら時間切れは鳴らない（#837）', async () => {
  const { app, connection } = await compacting(5)
  connection.emit(turnStarted)
  connection.emit(turnDone('completed'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(app.replying()['thread-1@repo'], undefined)
  assert.equal(connection.sent.some((message) => message.method === 'turn/interrupt'), false)
})

test('compact: 切断・スレッドが閉じた・途中で切られたは、済んだか分からないので失敗にする（#837）', async () => {
  const cut = await compacting()
  cut.connection.disconnect()
  assert.match(cut.app.replying()['thread-1@repo']?.failed?.tail ?? '', /接続が切れました/)
  assert.deepEqual(cut.ended, ['thread-1@repo'])

  const closed = await compacting()
  closed.connection.emit({ method: 'thread/closed', params: { threadId: 'thread-1' } })
  assert.match(closed.app.replying()['thread-1@repo']?.failed?.tail ?? '', /スレッドが閉じました/)

  const stopped = await compacting()
  stopped.connection.emit(turnStarted)
  stopped.connection.emit(turnDone('interrupted'))
  assert.match(stopped.app.replying()['thread-1@repo']?.failed?.tail ?? '', /interrupted/)
})

test('compact: 人が止めたときは失敗にしない。止めた預かりは呼ぶ側が持つ（#837）', async () => {
  const { app, connection } = await compacting()
  connection.emit(turnStarted)
  assert.equal(await app.interrupt('thread-1@repo'), true)
  connection.emit(turnDone('interrupted'))
  assert.equal(app.replying()['thread-1@repo'], undefined)
})

test('compact: 要約のターンには足せない。ほかの turn id の終わりでは片付けない（#837）', async () => {
  const { app, connection } = await compacting()
  connection.emit(turnStarted)
  assert.equal(await app.steer('thread-1@repo', '足したい'), false, '呼ぶ側が預かりに落とす')
  assert.equal(connection.sent.some((message) => message.method === 'turn/steer'), false)
  connection.emit(turnDone('completed', null, 'old-turn'))
  assert.equal(app.running('thread-1@repo'), true)
})

test('compact: 投げられなければ処理中を残さず、呼ぶ側に投げ返す（#837）', async () => {
  const connection = new FakeConnection()
  const app = new CodexAppServer(async () => connection)
  const original = connection.send.bind(connection)
  connection.send = (message) => {
    if (message.method === 'thread/compact/start') connection.emit({ id: message.id, error: { message: 'thread not found' } })
    else original(message)
  }
  await assert.rejects(app.compact({ id: 'thread-1@repo', threadId: 'thread-1', cwd: '/repo' }), /thread not found/)
  assert.equal(app.running('thread-1@repo'), false)
})

test('requestUserInput: 質問を表示し、question idへ安全に回答して二重回答を拒否する', async () => {
  const { app, connection } = await started()
  connection.emit({
    id: 41,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'ask-1', isBlocking: true,
      questions: [{ id: 'target', header: '対象', question: 'どれ?', isOther: true, isSecret: false, options: [{ label: 'Core', description: '本体' }] }],
    },
  })
  const approval = app.snapshot()['thread-1@repo']?.[0]
  assert.equal(approval?.agent, 'codex')
  assert.equal(approval?.tool_name, 'AskUserQuestion')
  assert.deepEqual(approval?.input.questions, [{ id: 'target', header: '対象', question: 'どれ?', isOther: true, isSecret: false, options: [{ label: 'Core', description: '本体' }], multiSelect: false }])
  const answer: ApprovalAnswer = { behavior: 'allow', updatedInput: { answers: { target: '自由記入' } } }
  assert.deepEqual(app.answer(approval!.approval_id, answer), { ok: true })
  assert.deepEqual(connection.sent.at(-1), { id: 41, result: { answers: { target: { answers: ['user_note: 自由記入'] } } } })
  assert.equal(app.answer(approval!.approval_id, answer).ok, false, '同じrequestへ二回答えない')
})

test('command approval: availableDecisionsだけを出し、選んだ実値をそのまま返す', async () => {
  const { app, connection } = await started()
  // 規則の追加（今後も聞かない）は、覚えられる範囲をボタンに書く（#741）
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } }
  connection.emit({
    id: 'cmd-rpc', method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', startedAtMs: Date.parse('2026-09-09T11:59:00Z'), command: 'git status', cwd: '/repo', availableDecisions: ['decline', amendment] },
  })
  const approval = app.snapshot()['thread-1@repo']![0]!
  assert.deepEqual(approval.decisions?.map(({ label, behavior }) => ({ label, behavior })), [
    { label: '拒否', behavior: 'deny' },
    { label: '許可して、「git status」で始まるコマンドを今後聞かない', behavior: 'allow' },
  ])
  assert.deepEqual(app.answer(approval.approval_id, { behavior: 'allow', decision: 'd0' }), { ok: false, status: 400, error: '提示されていないdecisionです' }, 'behaviorの改ざんも拒否')
  assert.deepEqual(app.answer(approval.approval_id, { behavior: 'allow', decision: 'not-offered' }), { ok: false, status: 400, error: '提示されていないdecisionです' })
  assert.deepEqual(app.answer(approval.approval_id, { behavior: 'allow', decision: 'd1' }), { ok: true, kept: { kind: 'command', scope: 'git status' } }, '規則の追加を押したら、ボタンに書いた範囲を返す（#772）')
  assert.deepEqual(connection.sent.at(-1), { id: 'cmd-rpc', result: { decision: amendment } })
})

test('command approval: 範囲をボタンに書けない規則の追加は出さず、その id では答えられない（#741）', async () => {
  const { app, connection } = await started()
  const unreadable = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['sh', '-c', `echo ${'x'.repeat(200)}`] } }
  const nameless = { acceptWithExecpolicyAmendment: {} }
  const allowHost = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'allow' } } }
  const denyHost = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'deny' } } }
  const badHost = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'not a host', action: 'allow' } } }
  connection.emit({
    id: 'cmd-rpc', method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'curl example.com', cwd: '/repo', availableDecisions: ['accept', unreadable, nameless, allowHost, denyHost, badHost, 'cancel'] },
  })
  const approval = app.snapshot()['thread-1@repo']![0]!
  assert.deepEqual(approval.decisions, [
    { id: 'd0', label: '許可', behavior: 'allow' },
    // 残る候補には印を付ける（画面は「許可」と同じ塗りにしない）。今回かぎりの候補には付けない
    { id: 'd3', label: '「example.com」への通信を今後聞かない', behavior: 'allow', persists: true },
    { id: 'd4', label: '「example.com」への通信を今後も断る', behavior: 'deny', persists: true },
    { id: 'd6', label: 'ターンを中止', behavior: 'deny' },
  ])
  // 出していない候補の id は通らない（落とした規則の追加を、id を当てて押させない）
  for (const hidden of ['d1', 'd2', 'd5']) {
    assert.deepEqual(app.answer(approval.approval_id, { behavior: 'allow', decision: hidden }), { ok: false, status: 400, error: '提示されていないdecisionです' }, hidden)
  }
  assert.deepEqual(app.answer(approval.approval_id, { behavior: 'allow', decision: 'd4' }), { ok: false, status: 400, error: '提示されていないdecisionです' }, '断る規則を許可として送らせない')
  assert.deepEqual(app.answer(approval.approval_id, { behavior: 'deny', decision: 'd4' }), { ok: true, kept: { kind: 'network', scope: 'example.com' } }, '押した範囲を返す（#772。記録に残すのは app.ts）')
  assert.deepEqual(connection.sent.at(-1), { id: 'cmd-rpc', result: { decision: denyHost } })
})

test('command approval: 知らない名前の候補は出さない。出せる候補が 1 つも無ければ、画面からは答えられないと出す（#742 のレビュー）', async () => {
  const { app, connection } = await started()
  connection.emit({
    id: 'cmd-a', method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-a', command: 'git status', cwd: '/repo', availableDecisions: ['accept', 'acceptAlways', { declineWithSomething: { x: 1 } }, 'toString'] },
  })
  const first = app.snapshot()['thread-1@repo']![0]!
  assert.deepEqual(first.decisions, [{ id: 'd0', label: '許可', behavior: 'allow' }])
  assert.equal(first.answerable, true)
  for (const hidden of ['d1', 'd2', 'd3']) assert.equal(app.answer(first.approval_id, { behavior: 'allow', decision: hidden }).ok, false, hidden)
  assert.deepEqual(app.answer(first.approval_id, { behavior: 'allow', decision: 'd0' }), { ok: true })

  // 来たのが、範囲を書けない規則の追加だけ
  const long = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['sh', '-c', 'x'.repeat(200)] } }
  connection.emit({
    id: 'cmd-b', method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-b', command: 'sh -c …', cwd: '/repo', availableDecisions: [long] },
  })
  const second = app.snapshot()['thread-1@repo']!.find((a) => a.tool_use_id === 'cmd-b')!
  assert.equal(second.decisions, undefined)
  assert.equal(second.answerable, false, '押しても通らないボタンを並べない')
  assert.equal(app.answer(second.approval_id, { behavior: 'allow' }).ok, false)
  assert.equal(app.answer(second.approval_id, { behavior: 'allow', decision: 'd0' }).ok, false)
})

test('file/permissions: 変更対象と追加権限を出し、turn/session/拒否を明示する', async () => {
  const { app, connection } = await started()
  connection.emit({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'fileChange', id: 'file-1', changes: [{ path: '/repo/a.ts', kind: 'update', diff: '+x' }] } } })
  connection.emit({ id: 51, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-1', reason: '編集' } })
  let approval = app.snapshot()['thread-1@repo']![0]!
  assert.match(approval.text, /a\.ts/)
  assert.deepEqual(approval.decisions?.map((decision) => decision.label), ['許可', 'セッション中許可', '拒否', 'ターンを中止'])
  connection.emit({ id: 52, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'perm-1', cwd: '/repo', permissions: { network: { enabled: true }, fileSystem: null } } })
  approval = app.snapshot()['thread-1@repo']!.find((item) => item.tool_name === 'CodexPermissions')!
  assert.deepEqual(approval.decisions?.map((decision) => decision.label), ['今回だけ許可', 'セッション中許可', '拒否'])
  assert.deepEqual(app.answer(approval.approval_id, { behavior: 'deny', decision: 'd2' }), { ok: true })
  assert.deepEqual(connection.sent.at(-1), { id: 52, result: { permissions: {}, scope: 'turn' } })
})

test('lifecycle: resolved・turn完了・切断で待機を消し、別threadへは配送しない', async () => {
  const { app, connection } = await started()
  const request = (id: number) => connection.emit({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: `cmd-${id}`, command: 'ls', availableDecisions: ['accept'] } })
  request(61)
  connection.emit({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 61 } })
  assert.deepEqual(app.snapshot(), {})
  connection.emit({ id: 62, method: 'item/fileChange/requestApproval', params: { threadId: 'other', turnId: 'turn-1', itemId: 'x' } })
  assert.deepEqual(connection.sent.at(-1), { id: 62, error: { code: -32602, message: 'thread/turn is not managed by SAI' } })
  request(63)
  connection.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
  assert.equal(app.running('thread-1@repo'), false)
  assert.deepEqual(app.snapshot(), {})

  await app.start({ id: 'thread-1@repo', threadId: 'thread-1', text: '再開', cwd: '/repo' })
  request(64)
  connection.disconnect()
  assert.equal(app.running('thread-1@repo'), false)
  assert.deepEqual(app.snapshot(), {})
})

test('onTurnEnd: ターンが終わったら（完了・切断）片付けたあとに知らせる。預かった次の返信を回すのに使う（#305）', async () => {
  const { app, connection } = await started()
  const ended: { id: string; running: boolean }[] = []
  app.onTurnEnd((id) => ended.push({ id, running: app.running(id) }))
  app.onTurnEnd(() => {
    throw new Error('知らせた先が投げても、片付けは止めない')
  })
  connection.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
  assert.deepEqual(ended, [{ id: 'thread-1@repo', running: false }], '知らせた時点ではもう処理中ではない（次をすぐ起動できる）')

  // 片付け済みの thread にもう一度届いても、二重には知らせない
  connection.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
  assert.equal(ended.length, 1)

  await app.start({ id: 'thread-1@repo', threadId: 'thread-1', text: '再開', cwd: '/repo' })
  connection.disconnect()
  assert.equal(ended.length, 2)
  assert.deepEqual(ended.at(-1), { id: 'thread-1@repo', running: false }, '切断で終わったターンも知らせる')
})

test('holds: thread/resume したスレッドは、ターンが終わっても thread/closed・切断まで持っている（#329）', async () => {
  const { app, connection } = await started()
  assert.equal(app.holds('thread-1'), true)
  assert.equal(app.holds('other'), false)
  // app-server はターンが終わってもスレッドを読み込んだまま（writer lock を開いたまま）
  connection.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
  assert.equal(app.running('thread-1@repo'), false)
  assert.equal(app.holds('thread-1'), true, 'ターンが終わっても持っている')
  connection.emit({ method: 'thread/closed', params: { threadId: 'thread-1' } })
  assert.equal(app.holds('thread-1'), false, '閉じたら持っていない')

  await app.start({ id: 'thread-1@repo', threadId: 'thread-1', text: '再開', cwd: '/repo' })
  assert.equal(app.holds('thread-1'), true)
  connection.disconnect()
  assert.equal(app.holds('thread-1'), false, '切断したら持っていない')
})

test('skills: skills/list を 60 秒覚える。取れなければ空で返す（#402）', async () => {
  const connection = new FakeConnection()
  let now = Date.parse('2026-09-09T12:00:00Z')
  const app = new CodexAppServer(async () => connection, () => now)
  connection.skillsResult = {
    data: [{
      cwd: '/srv',
      skills: [
        { name: 'imagegen', description: '画像を作る', scope: 'system', enabled: true },
        { name: 'repo-one', description: 'サーバの cwd の分', scope: 'repo', enabled: true },
      ],
    }],
  }
  assert.deepEqual((await app.skills()).map((s) => s.name), ['imagegen'], 'scope が repo の分は落とす')
  const asked = () => connection.sent.filter((m) => m.method === 'skills/list').length
  assert.equal(asked(), 1)
  assert.deepEqual((await app.skills()).map((s) => s.name), ['imagegen'])
  assert.equal(asked(), 1, '60 秒のうちは聞き直さない')
  now += 61_000
  connection.skillsResult = { data: [{ cwd: '/srv', skills: [{ name: 'imagegen', description: '画像を作る', scope: 'system', enabled: true }, { name: 'pdf:fill', description: '増えた分', scope: 'user', enabled: true }] }] }
  assert.deepEqual((await app.skills()).map((s) => s.name), ['imagegen', 'pdf:fill'], '過ぎたら聞き直す')
  assert.equal(asked(), 2)

  now += 61_000
  connection.skillsResult = null
  assert.deepEqual((await app.skills()).map((s) => s.name), ['imagegen', 'pdf:fill'], '取れなければ覚えている分を返す')
  const fresh = new CodexAppServer(async () => { const c = new FakeConnection(); c.skillsResult = null; return c }, () => now)
  assert.deepEqual(await fresh.skills(), [], '一度も取れていなければ空（返信は止めない）')
})

// ---- #384: 処理中のターンを止める（turn/interrupt）

test('interrupt: 走っているターンに turn/interrupt を投げ、処理中から外す（#384）', async () => {
  const { app, connection } = await started()
  const ended: string[] = []
  app.onTurnEnd((id) => ended.push(id))
  connection.sent.length = 0

  assert.equal(await app.interrupt('thread-1@repo'), true)
  const sent = connection.sent.find((message) => message.method === 'turn/interrupt')
  assert.deepEqual(sent?.params, { threadId: 'thread-1', turnId: 'turn-1' })
  assert.equal(app.running('thread-1@repo'), false, '止めたら処理中ではない')
  assert.deepEqual(ended, ['thread-1@repo'], '預かりを回す側に「終わった」を知らせる')

  // 実測では turn/completed が少し遅れて届く。2 回片付けても壊れない
  connection.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } })
  assert.deepEqual(ended, ['thread-1@repo'], '同じターンで 2 回知らせない')
})

test('interrupt: 知らない id と、turn/start の応答前（turnId なし）は止めない（#384）', async () => {
  const { app, connection } = await started()
  connection.sent.length = 0
  assert.equal(await app.interrupt('ほかの@repo'), false, '走っていないセッション')
  assert.equal(connection.sent.length, 0, '走っていないなら投げない')

  // turn/start の応答を保留したまま start を回す（turnId がまだ決まっていない）
  const slow = new FakeConnection()
  slow.hold('turn/start')
  const app2 = new CodexAppServer(async () => slow, () => Date.parse('2026-09-09T12:00:00Z'))
  const starting = app2.start({ id: 'thread-2@repo', threadId: 'thread-2', text: 'go', cwd: '/repo' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(await app2.interrupt('thread-2@repo'), false, '止める先（turnId）がまだ無い')
  assert.equal(app2.replying()['thread-2@repo']?.interruptible, undefined, '画面にもボタンを出さない')
  assert.equal(slow.sent.some((message) => message.method === 'turn/interrupt'), false)
  slow.release()
  await starting
  assert.equal(await app2.interrupt('thread-2@repo'), true, 'turnId が入れば止められる')
})

test('interrupt: 別のスレッドのターンは触らない（#384）', async () => {
  const connection = new FakeConnection()
  const app = new CodexAppServer(async () => connection, () => Date.parse('2026-09-09T12:00:00Z'))
  await app.start({ id: 'A@repo', threadId: 'thread-A', text: 'a', cwd: '/repo' })
  await app.start({ id: 'B@repo', threadId: 'thread-B', text: 'b', cwd: '/repo' })
  connection.sent.length = 0

  assert.equal(await app.interrupt('A@repo'), true)
  const sent = connection.sent.filter((message) => message.method === 'turn/interrupt')
  assert.equal(sent.length, 1)
  assert.equal((sent[0]!.params as { threadId: string }).threadId, 'thread-A')
  assert.equal(app.running('B@repo'), true, 'もう一方は走ったまま')
})

test('startThread: thread/start で作ったスレッドは、最初のターンで resume しない（#401）', async () => {
  const connection = new FakeConnection()
  const app = new CodexAppServer(async () => connection, () => Date.parse('2026-09-09T12:00:00Z'))
  const threadId = await app.startThread('/repo')
  assert.equal(threadId, 'thread-new')
  const start = connection.sent.find((m) => m.method === 'thread/start')
  assert.deepEqual(start?.params, { cwd: '/repo' }, 'cwd だけ渡す')

  await app.start({ id: 'thread-new@repo', threadId, text: 'はじめまして', cwd: '/repo', model: 'gpt-test' })
  assert.deepEqual(
    connection.sent.map((m) => m.method),
    ['initialize', 'initialized', 'thread/start', 'turn/start'],
    '作りたてのスレッドは rollout がまだ無いので thread/resume を投げない',
  )
  const turn = connection.sent.find((m) => m.method === 'turn/start')?.params as Record<string, unknown>
  assert.equal(turn.threadId, threadId)
  assert.equal(turn.model, 'gpt-test', 'resume を飛ばしてもモデルは turn/start で渡る')
  assert.equal(turn.approvalsReviewer, 'user', '許可も今までどおり SAI が答える')
  assert.equal(app.running('thread-new@repo'), true)
  assert.equal(app.holds(threadId), true, 'この接続が持っている（queue に回さない）')

  // 2 回目は普通のスレッドとして resume する
  connection.emit({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1' } } })
  await app.start({ id: 'thread-new@repo', threadId, text: '続けて', cwd: '/repo' })
  assert.deepEqual(connection.sent.map((m) => m.method).slice(4), ['thread/resume', 'turn/start'])
})

test('startThread: 応答に id が無ければ投げる（#401）', async () => {
  const connection = new FakeConnection()
  connection.newThread = null
  const app = new CodexAppServer(async () => connection, () => Date.parse('2026-09-09T12:00:00Z'))
  await assert.rejects(() => app.startThread('/repo'), /thread id/)
})

test('steer: expectedTurnId を付けて投げ、足せなければ false（#404）', async () => {
  const { app, connection } = await started()
  // turn/start の応答で turnId が入っている
  assert.equal(await app.steer('thread-1@repo', 'テストも直して', ['/tmp/a.png']), true)
  const sent = connection.sent.find((m) => m.method === 'turn/steer')?.params as Record<string, unknown>
  assert.equal(sent.threadId, 'thread-1')
  assert.equal(sent.expectedTurnId, 'turn-1', '別のターンに変わっていれば app-server が断る（実測）')
  assert.deepEqual(sent.input, [
    { type: 'text', text: 'テストも直して', text_elements: [] },
    { type: 'localImage', path: '/tmp/a.png' },
  ])

  assert.equal(await app.steer('よその@repo', 'x'), false, '処理中でないセッションには足さない')

  // app-server が断ったら false（呼び出し側が預かりに落とす）
  connection.failSteer = true
  assert.equal(await app.steer('thread-1@repo', 'もう終わってた'), false)

  // ターンが終わったら足す先が無い
  connection.failSteer = false
  connection.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
  assert.equal(await app.steer('thread-1@repo', 'あとから'), false)
})

test('turn/completed が failed なら、エラーの文を失敗として残す（#475。エラーのターンは notify が鳴らず行が残らない）', async () => {
  let now = Date.parse('2026-09-09T12:00:00Z')
  const connection = new FakeConnection()
  const app = new CodexAppServer(async () => connection, () => now)
  await app.start({ id: 'thread-1@repo', threadId: 'thread-1', text: '続けて', cwd: '/repo' })
  // 実測（codex 0.154.0）の形: error.message は API の応答を JSON にした文字列のこともある
  const error = { message: '{"type":"error","status":400,"error":{"message":"The \'x\' model is not supported when using Codex with a ChatGPT account."}}', codexErrorInfo: 'other' }
  connection.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error } } })
  assert.equal(app.running('thread-1@repo'), false, '処理中ではない（次の返信を止めない）')
  const failed = app.replying()['thread-1@repo']
  assert.equal(failed?.text, '続けて')
  assert.match(failed?.failed?.tail ?? '', /model is not supported/)
  assert.match(failed?.failed?.tail ?? '', /記録の行は残りません/)

  // 次のターンを始めたら消え、回っているターンとして出る
  await app.start({ id: 'thread-1@repo', threadId: 'thread-1', text: '再開', cwd: '/repo' })
  assert.equal(app.replying()['thread-1@repo']?.failed, undefined)
  assert.equal(app.replying()['thread-1@repo']?.text, '再開')

  // 成功したターンは失敗を残さない
  connection.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', error: null } } })
  assert.equal(app.replying()['thread-1@repo'], undefined)

  // 失敗は 30 分で消える
  await app.start({ id: 'thread-1@repo', threadId: 'thread-1', text: 'もう一度', cwd: '/repo' })
  connection.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-3', status: 'failed', error: { message: "You've hit your usage limit." } } } })
  assert.ok(app.replying()['thread-1@repo']?.failed)
  now += CODEX_TURN_FAILED_TTL_MS + 1
  assert.equal(app.replying()['thread-1@repo'], undefined)
})

test('ownPid: 繋いでいる app-server の pid。thread/closed で holds() が偽になっても変わらず、切断で 0（#482）', async () => {
  const connection = new FakeConnection()
  const app = new CodexAppServer(async () => connection, () => Date.parse('2026-09-09T12:00:00Z'))
  assert.equal(app.ownPid(), 0, 'まだ繋いでいない')
  await app.start({ id: 'thread-1@repo', threadId: 'thread-1', text: '続けて', cwd: '/repo' })
  assert.equal(app.ownPid(), 9191)
  assert.equal(app.holds('thread-1'), true)
  connection.emit({ method: 'thread/closed', params: { threadId: 'thread-1' } })
  assert.equal(app.holds('thread-1'), false)
  assert.equal(app.ownPid(), 9191, 'thread/closed のあとも app-server は生きている（行の pid はこれを指したまま）')
  connection.disconnect()
  assert.equal(app.ownPid(), 0)
})

test('fork: thread/fork に threadId だけを渡し、分岐先の最初のターンでは resume しない（#405）', async () => {
  const connection = new FakeConnection()
  const app = new CodexAppServer(async () => connection, () => Date.parse('2026-10-07T06:00:00Z'))
  const forked = await app.fork('thread-src')
  assert.equal(forked, 'thread-forked')
  const sent = connection.sent.find((m) => m.method === 'thread/fork')
  // cwd・model・sandbox・approvalPolicy の上書きは渡さない（元のスレッドのまま）。履歴は返させない
  assert.deepEqual(sent?.params, { threadId: 'thread-src', excludeTurns: true })

  await app.start({ id: 'thread-forked@repo', threadId: forked, text: '別の方針で', cwd: '/repo' })
  assert.deepEqual(
    connection.sent.map((m) => m.method),
    ['initialize', 'initialized', 'thread/fork', 'turn/start'],
    '分岐先はこの接続がもう読み込んでいるので thread/resume を投げない（0.160.1 で実測）',
  )
  assert.equal((connection.sent.at(-1)!.params as { threadId: string }).threadId, 'thread-forked', 'ターンは分岐先で回す（元のスレッドではない）')
  assert.equal(app.running('thread-forked@repo'), true)
  assert.equal(app.holds('thread-src'), false, '元のスレッドは読み込まない')
})

test('fork: 新しい id が取れない応答は失敗にする（元のスレッドでターンを回さない）', async () => {
  const connection = new FakeConnection()
  const app = new CodexAppServer(async () => connection)
  connection.forked = null
  await assert.rejects(app.fork('thread-src'), /thread\/fork/)
  connection.forked = 'thread-src'
  await assert.rejects(app.fork('thread-src'), /thread\/fork/, '元と同じ id が返ったら分岐できていない')
})

/** `account/rateLimits/read` の答えの形（0.165 で実測。数字は作り物） */
const limitsAnswer = (used: number) => ({
  ordinaryUsageAllowed: true,
  rateLimits: { limitId: 'codex', primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 1793000000 }, secondary: null, planType: 'plus', credits: null },
  rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 1793000000 }, secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1793500000 }, planType: 'plus' } },
  rateLimitResetCredits: { availableCount: 0, credits: null },
  accountId: 'acct',
  rateLimitUpsell: null,
})

test('readRateLimits: 押したときに呼ばれ、繋いでいなければ app-server を起こして account/rateLimits/read を聞く（#832）', async () => {
  let connects = 0
  const connection = new FakeConnection()
  const app = new CodexAppServer(async () => {
    connects++
    return connection
  }, () => Date.parse('2026-10-28T03:00:00Z'))
  assert.equal(app.rateLimitsSeen(), null, '通知を覚えるだけでは起こさない')
  assert.equal(connects, 0)

  connection.rateLimitsResult = limitsAnswer(42)
  const usage = await app.readRateLimits()
  assert.equal(connects, 1, '繋いでいなければ起こす（返信と同じ 1 本）')
  assert.deepEqual(connection.sent.map((m) => m.method), ['initialize', 'initialized', 'account/rateLimits/read'], 'initialize を済ませてから聞く')
  assert.deepEqual(usage, {
    primary: { used_percent: 42, window_minutes: 300, resets_at: 1793000000 },
    secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1793500000 },
    plan: 'plus',
    at: '2026-10-28T03:00:00.000Z',
  })
  const ask = connection.sent.find((m) => m.method === 'account/rateLimits/read')
  assert.deepEqual(ask?.params, { excludeResetCreditDetails: true })

  // 繋いだあとは同じ接続に聞く（もう 1 本起こさない）
  await app.readRateLimits()
  assert.equal(connects, 1)

  // 聞けなかったら、覚えている値を返す
  connection.rateLimitsResult = null
  assert.deepEqual(await app.readRateLimits(), usage)
  // 形が違う答えは拾わない（前の値を残す）
  connection.rateLimitsResult = { rateLimits: { primary: { used: 10 } } }
  assert.deepEqual(await app.readRateLimits(), usage)
})

test('readRateLimits: app-server を起こせなくても落とさず、覚えている値を返す（#832。codex が無い環境）', async () => {
  const app = new CodexAppServer(async () => {
    throw new Error('spawn codex ENOENT')
  }, () => Date.parse('2026-10-28T03:00:00Z'))
  assert.equal(await app.readRateLimits(), null)
})

test('rateLimitsSeen: account/rateLimits/updated の通知を覚える。Codex でない枠・形の違う通知は拾わない（#832）', async () => {
  const { app, connection } = await started()
  assert.equal(app.rateLimitsSeen(), null)
  connection.emit({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1793000000 } } } })
  assert.deepEqual(app.rateLimitsSeen(), { primary: { used_percent: 12, window_minutes: 300, resets_at: 1793000000 }, at: '2026-09-09T12:00:00.000Z' })
  connection.emit({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'other-model', primary: { usedPercent: 99, windowDurationMins: 300 } } } })
  connection.emit({ method: 'account/rateLimits/updated', params: { rateLimits: 'x' } })
  assert.equal(app.rateLimitsSeen()?.primary.used_percent, 12)
  assert.ok(!connection.sent.some((m) => m.method === 'account/rateLimits/read'), '通知を受けるだけでは聞きに行かない')
})
