// 成果の確認（#903）の純粋関数。どの返答を確認待ちにするか・直したあとの返答に移るか・確認を引き継がないか
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachResults, checkKey, resultNeedsCheck, resultPrs, uncheckedCount } from './agentResults.ts'
import type { AgentRequest } from './types.ts'

test('resultNeedsCheck: PR の URL・PR #N・画像を出した返答だけ（#N だけ・進捗・質問は入れない）', () => {
  assert.equal(resultNeedsCheck('https://github.com/owner-a/repo-a/pull/12 を出しました'), true)
  assert.equal(resultNeedsCheck('PR #12 を出しました'), true)
  assert.equal(resultNeedsCheck('PR#12 を直しました'), true)
  assert.equal(resultNeedsCheck('撮りました ![狭い幅](.screenshots/a.png)'), true)
  assert.equal(resultNeedsCheck('#12 に着手します'), false)
  assert.equal(resultNeedsCheck('読み始めました。終わったら返します'), false)
  assert.equal(resultNeedsCheck('どちらにしますか？'), false)
  assert.equal(resultNeedsCheck('https://github.com/owner-a/repo-a/issues/12'), false)
  assert.equal(resultNeedsCheck('APR #12'), false)
})

test('resultPrs: URL と、リモートが分かるときの PR #N。#N だけは読まない。重複は後ろへ', () => {
  assert.deepEqual(resultPrs('PR #3 と https://github.com/owner-b/repo-b/pull/4、#5、もう一度 PR #3', 'owner-a/repo-a'), [
    { repo: 'owner-b/repo-b', number: 4 },
    { repo: 'owner-a/repo-a', number: 3 },
  ])
  assert.deepEqual(resultPrs('PR #3', ''), [], 'リモートが分からなければ PR #N は読まない')
})

const req = (items: AgentRequest['items']): AgentRequest[] => [{ turn: '2026-11-01T00:00:00.000Z', items }]
const done = (id: string, to = 'B@r', extra: Partial<AgentRequest['items'][number]> = {}) => ({ message_id: id, to, to_name: to, status: 'done' as const, at: '2026-11-01T00:00:01.000Z', reply_ts: 't1', ...extra })

test('attachResults: 成果の返答だけに result が付き、確認は鍵（送り元・相手・行の ts）で引く', () => {
  const replies = new Map([
    ['m1', { ts: '2026-11-01T00:01:00+00:00', text: 'PR #7 を出しました' }],
    ['m2', { ts: '2026-11-01T00:02:00+00:00', text: '読みました' }],
  ])
  const checks = new Map([[checkKey('A@r', 'B@r', '2026-11-01T00:01:00+00:00'), '2026-11-01T01:00:00.000Z']])
  const [r] = attachResults(req([done('m1'), done('m2'), { ...done('m3'), status: 'pending' }]), 'A@r', replies, [], (k) => checks.get(k), () => 'owner-a/repo-a')
  assert.deepEqual(r!.items[0]!.result, { ts: '2026-11-01T00:01:00+00:00', checked_at: '2026-11-01T01:00:00.000Z', prs: [{ repo: 'owner-a/repo-a', number: 7 }] })
  assert.equal(r!.items[1]!.result, undefined, '進捗の報告')
  assert.equal(r!.items[2]!.result, undefined, '返答待ち')
  // 別の送り元の確認は付かない
  const [other] = attachResults(req([done('m1')]), 'C@r', replies, [], (k) => checks.get(k), () => 'owner-a/repo-a')
  assert.equal(other!.items[0]!.result?.checked_at, undefined)
})

test('attachResults: 直しを頼んで返った新しい返答に移り、前の確認は引き継がない。PR が無ければ前の PR を引き継ぐ', () => {
  const t1 = '2026-11-01T00:01:00+00:00'
  const t2 = '2026-11-01T00:05:00+00:00'
  const t3 = '2026-11-01T00:09:00+00:00'
  const replies = new Map([['m1', { ts: t1, text: 'PR #7 を出しました' }]])
  const followups = [
    { to: 'B@r', anchor: t1, reply: { ts: t2, text: '直して push しました' } },
    // 返答の来ていない返信は鎖を伸ばさない
    { to: 'B@r', anchor: t2 },
    // 別の相手の同じ ts の返信は混ぜない
    { to: 'C@r', anchor: t1, reply: { ts: t3, text: 'PR #9' } },
  ]
  const checks = new Map([[checkKey('A@r', 'B@r', t1), '2026-11-01T00:02:00.000Z']])
  const [r] = attachResults(req([done('m1')]), 'A@r', replies, followups, (k) => checks.get(k), () => 'owner-a/repo-a')
  assert.deepEqual(r!.items[0]!.result, { ts: t2, revised: true, prs: [{ repo: 'owner-a/repo-a', number: 7 }] }, '新しい成果は確認待ち')
  // さらに直した返答があれば、そこまでたどる（同じバブルの下に 2 つ返っていれば新しい方）
  const more = [...followups, { to: 'B@r', anchor: t2, reply: { ts: t3, text: 'PR #8 に分けました' } }, { to: 'B@r', anchor: t2, reply: { ts: '2026-11-01T00:06:00+00:00', text: '途中' } }]
  const checked2 = new Map([[checkKey('A@r', 'B@r', t3), '2026-11-01T00:10:00.000Z']])
  const [r2] = attachResults(req([done('m1')]), 'A@r', replies, more, (k) => checked2.get(k), () => 'owner-a/repo-a')
  assert.deepEqual(r2!.items[0]!.result, { ts: t3, revised: true, checked_at: '2026-11-01T00:10:00.000Z', prs: [{ repo: 'owner-a/repo-a', number: 8 }] })
})

test('attachResults: 別のリポジトリの相手には PR を付けない（確認待ちにはする）。輪になった返信でも止まる', () => {
  const t1 = '2026-11-01T00:01:00+00:00'
  const replies = new Map([['m1', { ts: t1, text: 'https://github.com/owner-b/repo-b/pull/3' }]])
  const loop = [{ to: 'B@x', anchor: t1, reply: { ts: t1, text: 'PR #4' } }]
  const [r] = attachResults(req([done('m1', 'B@x', { far: true })]), 'A@r', replies, loop, () => undefined, () => 'owner-b/repo-b')
  assert.deepEqual(r!.items[0]!.result, { ts: t1 })
  assert.equal(uncheckedCount(r!.items), 1)
})
