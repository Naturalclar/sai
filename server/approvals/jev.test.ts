import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Approval, ApprovalMap } from '../../shared/types.ts'
import { JEV_ENDPOINT, JEV_KEEP_MS, JevRisk, jevFromEnv } from './jev.ts'
import type { JevJudge } from './jev.ts'

const approval = (id: string, over: Partial<Approval> = {}): Approval => ({
  approval_id: id,
  id: 'S@sai',
  since: '2026-09-25T10:00:00Z',
  tool_name: 'Bash',
  input: { command: `cmd-${id}` },
  tool_use_id: id,
  text: `許可待ち: Bash: cmd-${id}`,
  ...over,
})
const mapOf = (...list: Approval[]): ApprovalMap => ({ 'S@sai': list })
const settle = () => new Promise((r) => setImmediate(r))

/** 呼ばれた state を覚え、決めた確率を返す偽の口 */
function fakeJudge(answer: (state: string) => number | Error = () => 0.9) {
  const calls: string[] = []
  const judge: JevJudge = async (state) => {
    calls.push(state)
    const out = answer(state)
    if (out instanceof Error) throw out
    return out
  }
  return { judge, calls }
}

test('jevFromEnv: 鍵が無ければ null（何も送らない）', () => {
  assert.equal(jevFromEnv({}), null)
  assert.equal(jevFromEnv({ JEV_API_KEY: '  ' }), null)
})

test('jevFromEnv: 決めた送り先に鍵を付けて送り、リダイレクトは追わない。応答から確率を読む', async () => {
  const seen: { url: string; init: RequestInit }[] = []
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    return new Response(JSON.stringify({ answers: { safe: { type: 'noul', noul: 0.42 } } }), { status: 200 })
  }) as unknown as typeof fetch
  const judge = jevFromEnv({ JEV_API_KEY: 'k-123' }, fakeFetch)!
  assert.equal(await judge('STATE'), 0.42)
  assert.equal(seen[0]!.url, JEV_ENDPOINT)
  assert.equal(seen[0]!.init.redirect, 'error', '鍵を付けたまま別の場所へ送らない')
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, 'Bearer k-123')
  const body = JSON.parse(String(seen[0]!.init.body)) as { state: string; questions: Record<string, { type: string }> }
  assert.equal(body.state, 'STATE')
  assert.equal(body.questions.safe?.type, 'noul')
})

test('jevFromEnv: HTTP のエラーと形の違う応答は投げる（確率をでっち上げない）', async () => {
  const status = (code: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status: code })) as unknown as typeof fetch
  await assert.rejects(jevFromEnv({ JEV_API_KEY: 'k' }, status(401, {}))!('s'), /HTTP 401/)
  await assert.rejects(jevFromEnv({ JEV_API_KEY: 'k' }, status(200, { answers: {} }))!('s'), /確率がありません/)
})

test('annotate: 初回は投げるだけで付かず、届いたら次から付く。元のオブジェクトは書き換えない', async () => {
  const { judge, calls } = fakeJudge(() => 0.97)
  const risk = new JevRisk(judge)
  const original = approval('a')
  const first = risk.annotate(mapOf(original), true)
  assert.equal(first['S@sai']![0]!.jev, undefined, '答えを待たずに返す')
  const before = risk.key()
  await settle()
  assert.notEqual(risk.key(), before, '届いたら rev に混ぜる鍵が変わる')
  const second = risk.annotate(mapOf(original), true)
  assert.equal(second['S@sai']![0]!.jev, 0.97)
  assert.equal(original.jev, undefined, '承認の預かりが持っている本物は触らない')
  assert.equal(calls.length, 1)
})

test('annotate: 同じ許可には 1 回だけ聞く（ポーリングのたびに聞かない。失敗も聞き直さない）', async () => {
  const { judge, calls } = fakeJudge((state) => (state.includes('cmd-bad') ? new Error('boom') : 0.5))
  const risk = new JevRisk(judge)
  for (let i = 0; i < 5; i++) {
    risk.annotate(mapOf(approval('ok'), approval('bad')), true)
    await settle()
  }
  assert.equal(calls.length, 2)
  const out = risk.annotate(mapOf(approval('ok'), approval('bad')), true)['S@sai']!
  assert.equal(out[0]!.jev, 0.5)
  assert.equal(out[1]!.jev, undefined, '聞けなかったものは付けない')
  assert.equal(risk.lastError, 'boom')
})

test('annotate: 切っていれば聞かず、覚えている確率も付けない。鍵が無ければ何もしない', async () => {
  const { judge, calls } = fakeJudge()
  const risk = new JevRisk(judge)
  risk.annotate(mapOf(approval('a')), true)
  await settle()
  assert.equal(risk.annotate(mapOf(approval('a'), approval('b')), false)['S@sai']![0]!.jev, undefined)
  assert.equal(calls.length, 1, '切っている間に出た b には聞かない')

  const none = new JevRisk(null)
  assert.equal(none.ready, false)
  assert.equal(none.annotate(mapOf(approval('a')), true)['S@sai']![0]!.jev, undefined)
})

test('annotate: 検出専用と質問には聞かない', async () => {
  const { judge, calls } = fakeJudge()
  const risk = new JevRisk(judge)
  risk.annotate(mapOf(approval('dialog', { answerable: false }), approval('ask', { tool_name: 'AskUserQuestion' })), true)
  await settle()
  assert.equal(calls.length, 0)
})

test('annotate: 一度にたくさん出ても、同時に投げるのは 2 本まで', async () => {
  let inFlight = 0
  let peak = 0
  const judge: JevJudge = async () => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 5))
    inFlight--
    return 0.5
  }
  const risk = new JevRisk(judge)
  risk.annotate(mapOf(...['a', 'b', 'c', 'd', 'e'].map((id) => approval(id))), true)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(peak, 2)
  assert.ok(risk.annotate(mapOf(approval('e')), true)['S@sai']![0]!.jev === 0.5, '並んでいた分もいずれ届く')
})

test('annotate: 覚えた答えは時間が経ったら忘れる（投げている最中のものは忘れない）', async () => {
  let now = 0
  let release: (v: number) => void = () => {}
  const slow: JevJudge = (state) => (state.includes('cmd-slow') ? new Promise<number>((r) => (release = r)) : Promise.resolve(0.9))
  const risk = new JevRisk(slow, () => now)
  risk.annotate(mapOf(approval('fast'), approval('slow')), true)
  await settle()
  now = JEV_KEEP_MS + 1
  // fast は忘れて聞き直す（jev は付かない）。slow は投げている最中なので聞き直さない
  assert.equal(risk.annotate(mapOf(approval('fast')), true)['S@sai']![0]!.jev, undefined)
  release(0.1)
  await settle()
  assert.equal(risk.annotate(mapOf(approval('slow')), true)['S@sai']![0]!.jev, 0.1)
})

test('annotate: 長く待っている許可は、見かけている間は忘れず聞き直さない（忘れるのは見なくなってから。#493 のレビュー）', async () => {
  let now = 0
  const { judge, calls } = fakeJudge(() => 0.8)
  const risk = new JevRisk(judge, () => now)
  risk.annotate(mapOf(approval('long')), true)
  await settle()
  // 3 秒のポーリングで見かけ続けたまま、覚えておく長さを越える
  for (now = 0; now <= JEV_KEEP_MS * 2; now += JEV_KEEP_MS / 4) risk.annotate(mapOf(approval('long')), true)
  await settle()
  assert.equal(calls.length, 1, '聞き直さない')
  assert.equal(risk.annotate(mapOf(approval('long')), true)['S@sai']![0]!.jev, 0.8, '確率も付いたまま')
})
