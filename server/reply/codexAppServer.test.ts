import assert from 'node:assert/strict'
import test from 'node:test'
import type { ApprovalAnswer } from '../../shared/types.ts'
import { CodexAppServer, type CodexConnection } from './codexAppServer.ts'

type Message = Record<string, unknown> & { id?: string | number; method?: string; params?: unknown }

class FakeConnection implements CodexConnection {
  sent: Message[] = []
  private messages: ((message: Message) => void)[] = []
  private closes: ((error?: Error) => void)[] = []

  send(message: Message): void {
    this.sent.push(message)
    if (message.id === undefined || !message.method) return
    const result = message.method === 'turn/start'
      ? { turn: { id: 'turn-1' } }
      : message.method === 'thread/resume'
        ? { thread: { id: 'thread-1', status: { type: 'idle' } } }
        : {}
    queueMicrotask(() => this.emit({ id: message.id, result }))
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
  assert.deepEqual(app.replying()['thread-1@repo'], { since: '2026-09-09T12:00:00.000Z', text: '続けて' })
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
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['prefix_rule(pattern=["git", "status"], decision="allow")'] } }
  connection.emit({
    id: 'cmd-rpc', method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', startedAtMs: Date.parse('2026-09-09T11:59:00Z'), command: 'git status', cwd: '/repo', availableDecisions: ['decline', amendment] },
  })
  const approval = app.snapshot()['thread-1@repo']![0]!
  assert.deepEqual(approval.decisions?.map(({ label, behavior }) => ({ label, behavior })), [
    { label: '拒否', behavior: 'deny' },
    { label: '同種のコマンドを許可', behavior: 'allow' },
  ])
  assert.deepEqual(app.answer(approval.approval_id, { behavior: 'allow', decision: 'd0' }), { ok: false, status: 400, error: '提示されていないdecisionです' }, 'behaviorの改ざんも拒否')
  assert.deepEqual(app.answer(approval.approval_id, { behavior: 'allow', decision: 'not-offered' }), { ok: false, status: 400, error: '提示されていないdecisionです' })
  assert.deepEqual(app.answer(approval.approval_id, { behavior: 'allow', decision: 'd1' }), { ok: true })
  assert.deepEqual(connection.sent.at(-1), { id: 'cmd-rpc', result: { decision: amendment } })
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
