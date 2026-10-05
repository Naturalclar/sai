import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentFollowupLine, SessionSummary } from '../../shared/types.ts'
import { replyFooter, withJustSent } from './replyAcross.ts'

const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: 'B1@r', agent: 'claude', repo: 'r', session: 'B1', session_source: 'payload', host: 'mac', last_turn_ts: 't2', next_ask: 'マージして', ...over }) as SessionSummary
const line = (over: Partial<AgentFollowupLine> = {}): AgentFollowupLine => ({ id: 'f1', to: 'B1@r', to_name: 'セッション A', text: 'マージして', sent_at: '2026-10-05T03:10:00Z', anchor: 't2', ...over })
const base = { target: 'B1@r', tss: ['t2'], toName: 'セッション A', followups: [] as AgentFollowupLine[], justSent: [], targetBusy: false, host: 'mac' }

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

test('replyFooter / withJustSent: 送った直後の繋ぎは、サーバの行が増えたら重ねない。時計では比べない（#700）', () => {
  const at = Date.parse('2026-10-05T03:10:00Z')
  const sent = { to: 'B1@r', anchor: 't2', text: '進めて', at }
  const just = withJustSent([], [], sent, ['t2'])
  assert.deepEqual(replyFooter({ ...base, justSent: just, session: session() }).lines.map((l) => [l.text, l.toName, l.busy]), [['進めて', 'セッション A', true]])
  // サーバの時計が 1 分手前でも先でも、行が 1 つ増えたら届いたとみなす
  for (const sentAt of ['2026-10-05T03:09:00Z', '2026-10-05T03:11:00Z']) {
    const after = replyFooter({ ...base, justSent: just, followups: [line({ text: '進めて', sent_at: sentAt })], session: session() })
    assert.deepEqual(after.lines.map((l) => l.key), ['f1'], sentAt)
  }
  // 前に送った行がもう出ているバブルで送ったら、その行とは別に数える
  const old = [line({ id: 'f0', sent_at: '2026-10-05T03:00:00Z', reply_ts: 't3' })]
  const again = withJustSent([], old, sent, ['t2'])
  assert.equal(replyFooter({ ...base, justSent: again, followups: old, session: session() }).lines.length, 2)
  assert.equal(replyFooter({ ...base, justSent: again, followups: [...old, line({ id: 'f1' })], session: session() }).lines.length, 2, '届いたら繋ぎは消える')
  // 届く前に続けて 2 回送ったら、1 つ届いても 2 つ目の繋ぎは残る
  const twice = withJustSent(just, [], { ...sent, text: 'もう 1 つ', at: at + 1 }, ['t2'])
  assert.deepEqual(twice.map((j) => j.known), [0, 1])
  assert.deepEqual(replyFooter({ ...base, justSent: twice, followups: [line()], session: session() }).lines.map((l) => l.text), ['マージして', 'もう 1 つ'])
  assert.equal(replyFooter({ ...base, tss: ['t1'], justSent: just, session: session() }).lines.length, 0, '別のバブルの下には出さない')
})
