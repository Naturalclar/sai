import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentFollowupLine, SessionSummary } from '../../shared/types.ts'
import { replyFooter } from './replyAcross.ts'

const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: 'B1@r', agent: 'claude', repo: 'r', session: 'B1', session_source: 'payload', host: 'mac', last_turn_ts: 't2', next_ask: 'マージして', ...over }) as SessionSummary
const line = (over: Partial<AgentFollowupLine> = {}): AgentFollowupLine => ({ id: 'f1', to: 'B1@r', to_name: 'くらら', text: 'マージして', sent_at: '2026-10-05T03:10:00Z', anchor: 't2', ...over })
const base = { target: 'B1@r', tss: ['t2'], toName: 'くらら', followups: [] as AgentFollowupLine[], justSent: [], targetBusy: false, host: 'mac' }

test('replyFooter: 返信できる相手にだけ口を出す。判定は replyBlockedReason()（#700）', () => {
  assert.equal(replyFooter({ ...base, session: session() }).canReply, true)
  assert.equal(replyFooter({ ...base, session: undefined }).canReply, false, '一覧の窓の外の相手')
  assert.equal(replyFooter({ ...base, session: session({ archived: true }) }).canReply, false)
  const remote = replyFooter({ ...base, session: session({ host: 'other' }) })
  assert.deepEqual([remote.canReply, remote.quickAsk], [false, ''], '別のマシンの相手には案も出さない')
})

test('replyFooter: 1 押しの案は相手のもので、相手の最新の返答のバブルにだけ、相手が空いているときだけ出す（#700）', () => {
  assert.equal(replyFooter({ ...base, session: session() }).quickAsk, 'マージして')
  assert.equal(replyFooter({ ...base, tss: ['t1'], session: session() }).quickAsk, '', '前の返答の下には出さない')
  assert.equal(replyFooter({ ...base, targetBusy: true, session: session() }).quickAsk, '', '処理中・預かり中は出さない')
  assert.equal(replyFooter({ ...base, session: session({ next_ask: undefined }) }).quickAsk, '')
})

test('replyFooter: 送った行はそのバブルの下にだけ出し、「処理中」はまだ返っていない一番新しい 1 行にだけ添える（#700）', () => {
  const followups = [line({ id: 'f0', reply_ts: 't3' }), line({ id: 'f1' }), line({ id: 'f2', sent_at: '2026-10-05T03:12:00Z' }), line({ id: 'x', anchor: 't9' }), line({ id: 'y', to: 'C1@r' })]
  const busy = replyFooter({ ...base, followups, targetBusy: true, session: session() })
  assert.deepEqual(busy.lines.map((l) => [l.key, l.busy]), [['f0', false], ['f1', false], ['f2', true]])
  assert.deepEqual(replyFooter({ ...base, followups, session: session() }).lines.map((l) => l.busy), [false, false, false], '相手が空いていれば添えない')
  // 返信できない相手でも、送った行は出す
  assert.equal(replyFooter({ ...base, followups, session: undefined }).lines.length, 3)
})

test('replyFooter: 送った直後の繋ぎは、サーバの行が届いたら重ねない（#700）', () => {
  const at = Date.parse('2026-10-05T03:10:00Z')
  const just = [{ to: 'B1@r', anchor: 't2', text: '進めて', at }]
  const before = replyFooter({ ...base, justSent: just, session: session() })
  assert.deepEqual(before.lines.map((l) => [l.text, l.toName, l.busy]), [['進めて', 'くらら', true]])
  const after = replyFooter({ ...base, justSent: just, followups: [line({ text: '進めて', sent_at: '2026-10-05T03:09:58Z' })], session: session() })
  assert.deepEqual(after.lines.map((l) => l.key), ['f1'], '時計が少し手前でも同じ送信とみなす')
  const old = replyFooter({ ...base, justSent: just, followups: [line({ sent_at: '2026-10-05T03:00:00Z', reply_ts: 't3' })], session: session() })
  assert.equal(old.lines.length, 2, '前に送った行とは別')
  assert.equal(replyFooter({ ...base, tss: ['t1'], justSent: just, session: session() }).lines.length, 0, '別のバブルの下には出さない')
})
