// dots との会話ログ（#872）の組み立てと状態。作り物の行だけで見る
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canMoveDots, DOTS_STATES, dotsConversations, parseDotsLine } from './dots.ts'
import type { DotsLine, DotsMessage, DotsState } from './dots.ts'

const human = (id: string, conv: string, req: string, at: string, text = `人 ${id}`): DotsMessage => ({ type: 'message', id, conversation_id: conv, request_id: req, source: 'sai-human', at, text })
const dots = (id: string, conv: string, replyTo: string, at: string, text = `dots ${id}`): DotsMessage => ({ type: 'message', id, conversation_id: conv, reply_to: replyTo, source: 'dots', at, text })
const state = (req: string, s: DotsState, at: string, reason?: string): DotsLine => ({ type: 'state', request_id: req, state: s, at, ...(reason ? { reason } : {}) })

test('返答は reply_to で依頼に付く。書かれた順・時刻が入れ替わっても付く先は変わらない', () => {
  const lines: DotsLine[] = [
    // 2 つ目の依頼への返答が先に書かれ、時刻も 1 つ目への返答より前
    dots('d2', 'c1', 'r2', '2026-11-05T10:03:00Z'),
    human('h1', 'c1', 'r1', '2026-11-05T10:00:00Z'),
    human('h2', 'c1', 'r2', '2026-11-05T10:01:00Z'),
    dots('d1', 'c1', 'r1', '2026-11-05T10:04:00Z'),
  ]
  const [c] = dotsConversations(lines)
  assert.ok(c)
  assert.deepEqual(c.requests.map((r) => [r.message.id, r.replies.map((m) => m.id)]), [['h1', ['d1']], ['h2', ['d2']]])
  assert.deepEqual(c.orphans, [])
  // 逆順に読んでも同じ
  assert.deepEqual(dotsConversations([...lines].reverse()), [c])
})

test('付く先が無い・別の会話の依頼を指す返答は、捨てずにその会話の末尾に出す', () => {
  const out = dotsConversations([human('h1', 'c1', 'r1', '2026-11-05T10:00:00Z'), dots('d1', 'c2', 'r1', '2026-11-05T10:01:00Z'), dots('d2', 'c1', 'gone', '2026-11-05T10:02:00Z')])
  const c1 = out.find((c) => c.id === 'c1')
  const c2 = out.find((c) => c.id === 'c2')
  assert.deepEqual(c1?.requests[0]?.replies, [])
  assert.deepEqual(c1?.orphans.map((m) => m.id), ['d2'])
  assert.deepEqual(c2?.orphans.map((m) => m.id), ['d1'])
})

test('会話は新しく動いた順、会話の中は時系列。同じ id の行は先のものだけ', () => {
  const out = dotsConversations([
    human('a1', 'A', 'ra1', '2026-11-05T09:00:00Z'),
    human('b1', 'B', 'rb1', '2026-11-05T09:30:00Z'),
    human('a2', 'A', 'ra2', '2026-11-05T10:00:00Z'),
    human('a2', 'A', 'ra9', '2026-11-05T11:00:00Z', '重ねて書いた'),
  ])
  assert.deepEqual(out.map((c) => c.id), ['A', 'B'])
  assert.deepEqual(out[0]?.requests.map((r) => r.message.text), ['人 a1', '人 a2'])
  assert.equal(out[0]?.started_at, '2026-11-05T09:00:00Z')
  assert.equal(out[0]?.updated_at, '2026-11-05T10:00:00Z')
})

test('状態は行が無ければ queued。時刻の順に、進めない遷移を捨てながら当てる', () => {
  const h = human('h1', 'c1', 'r1', '2026-11-05T10:00:00Z')
  const st = (...lines: DotsLine[]) => dotsConversations([h, ...lines])[0]?.requests[0]
  assert.equal(st()?.state, 'queued')
  assert.equal(st(state('r1', 'accepted', '2026-11-05T10:01:00Z'), state('r1', 'awaiting', '2026-11-05T10:02:00Z'))?.state, 'awaiting')
  // 書かれた順が逆でも時刻で並べる
  assert.equal(st(state('r1', 'done', '2026-11-05T10:03:00Z'), state('r1', 'accepted', '2026-11-05T10:01:00Z'))?.state, 'done')
  // 終わった依頼は戻さない
  assert.equal(st(state('r1', 'failed', '2026-11-05T10:01:00Z', '届かなかった'), state('r1', 'accepted', '2026-11-05T10:02:00Z'))?.state, 'failed')
  assert.equal(st(state('r1', 'failed', '2026-11-05T10:01:00Z', '届かなかった'))?.reason, '届かなかった')
  // queued から直に done・awaiting へは飛ばない
  assert.equal(st(state('r1', 'awaiting', '2026-11-05T10:01:00Z'))?.state, 'queued')
  // 結果不明から分かった先へ。理由は進んだら消える
  const u = st(state('r1', 'unknown', '2026-11-05T10:01:00Z', '応答が無い'), state('r1', 'done', '2026-11-05T10:02:00Z'))
  assert.equal(u?.state, 'done')
  assert.equal(u?.reason, undefined)
  // 知らない依頼の状態は何にも付かない
  assert.equal(st(state('rX', 'done', '2026-11-05T10:01:00Z'))?.state, 'queued')
})

test('遷移の表: done と failed は終わり、同じ状態へは動かない', () => {
  for (const s of DOTS_STATES) {
    assert.equal(canMoveDots(s, s), false, s)
    if (s === 'done' || s === 'failed') for (const t of DOTS_STATES) assert.equal(canMoveDots(s, t), false, `${s}→${t}`)
  }
  assert.equal(canMoveDots('queued', 'accepted'), true)
  assert.equal(canMoveDots('unknown', 'done'), true)
})

test('受信箱の行として読めないものは null（人の投稿は request_id、返答は reply_to が要る）', () => {
  const ok = human('h1', 'c1', 'r1', '2026-11-05T10:00:00Z')
  assert.deepEqual(parseDotsLine(ok), ok)
  assert.equal(parseDotsLine({ ...ok, request_id: undefined }), null)
  assert.equal(parseDotsLine({ ...dots('d1', 'c1', 'r1', 'x'), reply_to: '' }), null)
  assert.equal(parseDotsLine({ ...ok, source: 'session' }), null)
  assert.equal(parseDotsLine({ type: 'state', request_id: 'r1', state: 'sent', at: 'x' }), null)
  assert.equal(parseDotsLine([ok]), null)
  // 余計なフィールドは持ち込まない
  assert.deepEqual(parseDotsLine({ ...ok, cwd: '/x' }), ok)
})
