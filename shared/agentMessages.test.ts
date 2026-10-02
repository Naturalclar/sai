import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_TURN_READ_BUDGET,
  AGENT_USAGE_STOP_PERCENT,
  AGENT_WEEKLY_STOP_PERCENT,
  AGENT_OVERLAP_SHOW,
  agentEntry,
  agentOverlap,
  agentReplyRows,
  replierName,
  agentTargets,
  budgetRefusal,
  clipReply,
  deliveredFromTailnet,
  deliveredId,
  deliveredText,
  isDeliveryOf,
  replyOf,
  sessionLabel,
  sendHow,
  resolveTarget,
  targetNames,
  targetRefusal,
  tokensLabel,
  usageRefusal,
  AGENT_HEADER_MARK,
  HANDED_MARK,
  HANDED_MAX_CHARS,
  HANDED_MAX_ITEMS,
  splitHandedReplies,
  withHandedReplies,
} from './agentMessages.ts'
import type { FeedRow, SessionSummary, UsageResponse } from './types.ts'
import { COMPACT_SUMMARY_HEAD, isCompactSummaryText } from './compactSummary.ts'

const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    project: 'o/r',
    agent: 'claude',
    session_source: 'payload',
    host: '',
    title: `${id} の題名`,
    branch: 'main',
    last_text: '',
    ...over,
  }) as SessionSummary

test('deliveredText / isDeliveryOf: 見出しの id で、そのメッセージで回ったターンかを見る（#310）', () => {
  const text = deliveredText({ label: '実装', project: 'o/r' }, 'abc123', '  テストを見て  ')
  assert.match(text, /^【SAI】#o\/r の「実装」からのメッセージです（id: abc123）/)
  assert.ok(text.endsWith('\n\nテストを見て'), '本文は前後の空白を落として見出しの後ろ')
  assert.equal(isDeliveryOf(text, 'abc123'), true)
  // record.py は user_text を 2000 字で切る。見出しは先頭にあるので、切れていても当たる
  assert.equal(isDeliveryOf(deliveredText({ label: 'x', project: 'o/r' }, 'abc123', 'あ'.repeat(5000)).slice(0, 2000), 'abc123'), true)
  assert.equal(isDeliveryOf(text, 'abc12'), false, '別の id（前方一致）には当たらない')
  assert.equal(isDeliveryOf('（id: abc123）人が打った', 'abc123'), false, '見出しの書き出しが無ければ人の入力')
  assert.equal(isDeliveryOf(undefined, 'abc123'), false)
})

test('replyOf: 相手のターン完了の行のうち、そのメッセージのものだけ', () => {
  const sent = deliveredText({ label: '実装', project: 'o/r' }, 'm1', '見て')
  const other = deliveredText({ label: '実装', project: 'o/r' }, 'm2', '別件')
  const rows = [
    { ts: '2026-09-11T01:00:00Z', session: 'B1', repo: 'r', event: 'UserPromptSubmit', user_text: sent, text: '' },
    { ts: '2026-09-11T01:01:00Z', session: 'B1', repo: 'r', event: 'PermissionRequest', user_text: sent, text: '許可待ち: Bash: ls' },
    { ts: '2026-09-11T01:02:00Z', session: 'C1', repo: 'r', event: 'Stop', user_text: sent, text: '別の相手' },
    { ts: '2026-09-11T01:03:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: other, text: '別のメッセージの返答' },
    { ts: '2026-09-11T01:04:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: sent, text: '見ました' },
  ] as FeedRow[]
  assert.equal(replyOf(rows, 'B1@r', 'm1')?.text, '見ました', '入力の行・待ちの行・別の相手・別の id は見ない')
  assert.equal(replyOf(rows, 'B1@r', 'm3'), null, 'まだ終わっていない')
})

test('deliveredId / agentReplyRows: 送ったメッセージへの返答（相手のターン完了の行）に印を付け、古い順に返す（#588）', () => {
  const m1 = deliveredText({ label: '実装', project: 'o/r' }, 'a1b2', '見て')
  const m2 = deliveredText({ label: '実装', project: 'o/r' }, 'c3d4', '別件')
  assert.equal(deliveredId(m1), 'a1b2')
  assert.equal(deliveredId('（id: a1b2）人が打った'), '', '見出しの書き出しが無ければ届けた文ではない')
  const rows = [
    { ts: '2026-10-01T01:30:00+09:00', session: 'B1', repo: 'r', event: 'Stop', user_text: m2, text: '別件の返答' },
    { ts: '2026-10-01T01:22:00+09:00', session: 'B1', repo: 'r', event: 'UserPromptSubmit', user_text: m1, text: '' },
    { ts: '2026-10-01T01:25:00+09:00', session: 'C1', repo: 'r', event: 'Stop', user_text: m1, text: '見出しを写しただけの別の相手' },
    { ts: '2026-10-01T01:40:00+09:00', session: 'B1', repo: 'r', event: 'Stop', user_text: m1, text: '着手しました' },
    { ts: '2026-10-01T01:45:00+09:00', session: 'B1', repo: 'r', event: 'Stop', user_text: m1, text: '2 本目（同じメッセージ）' },
  ] as FeedRow[]
  const sent = [
    { message_id: 'a1b2', to: 'B1@r', since: '2026-09-30T16:21:56Z' },
    { message_id: 'c3d4', to: 'B1@r', since: '2026-09-30T16:25:00Z' },
    { message_id: 'ffff', to: 'B1@r', since: '2026-09-30T16:26:00Z' },
  ]
  const out = agentReplyRows(sent, rows, (id) => (id === 'B1@r' ? '明.' : id))
  assert.deepEqual(out.map((r) => [r.text, r.agent_reply?.message_id, r.agent_reply?.to_name]), [
    ['別件の返答', 'c3d4', '明.'],
    ['着手しました', 'a1b2', '明.'],
  ], '入力の行・別の相手・2 本目・まだ返っていないものは入れない。古い順')
  assert.equal(out[1]?.agent_reply?.sent_at, '2026-09-30T16:21:56Z')
  assert.deepEqual(agentReplyRows([], rows, (id) => id), [])
})

test('replierName: 表示名があればそれ。題名が届けた見出しなら worktree 名（#588）', () => {
  const s = (over: Partial<SessionSummary>) => ({ id: 'B1@dev-min', title: '', repo: 'dev-min', ...over }) as SessionSummary
  assert.equal(replierName(s({ meta: { name: '明.' }, title: '【SAI】#o/r の「x」からのメッセージです' })), '明.')
  assert.equal(replierName(s({ title: '【SAI】#o/r の「x」からのメッセージです' })), '#dev-min')
  assert.equal(replierName(s({ title: 'PR を出して' })), 'PR を出して')
})

test('clipReply: 長ければ切って、切ったことを書く（#311）', () => {
  assert.equal(clipReply('  短い  '), '短い')
  const long = clipReply('あ'.repeat(30), 10)
  assert.ok(long.startsWith('あ'.repeat(10)))
  assert.match(long, /あと 20 字を省略/)
})

test('agentTargets: 同じ project・自分以外・アーカイブ済みでない・返信できる相手だけ', () => {
  const from = session('A1@r')
  const sessions = [
    from,
    session('B1@r'),
    session('C1@r', { project: 'o/other' }),
    session('D1@r', { archived: true }),
    session('R1@r', { host: 'mini' }),
    session('S1@r', { session_source: 'synth' }),
  ]
  assert.deepEqual(agentTargets(sessions, from, 'testmac').map((s) => s.id), ['B1@r'])
  assert.deepEqual(agentTargets(sessions, session('A1@r', { project: '' }), 'testmac'), [], 'どのリポジトリか分からない送り元からは送れない')
})

test('agentEntry / sessionLabel: 呼び名は表示名 → 題名 → ID。最後の発言は 1 行目だけで、長ければ切る', () => {
  assert.equal(sessionLabel(session('A1@r', { meta: { name: 'レビュー' } })), 'レビュー')
  assert.equal(sessionLabel(session('A1@r')), 'A1@r の題名')
  assert.equal(sessionLabel(session('A1@r', { title: '' })), 'A1@r')
  const entry = agentEntry(session('B1@r', { last_text: `${'あ'.repeat(130)}\n二行目` }), true)
  assert.equal(entry.busy, true)
  assert.equal(entry.last_text, `${'あ'.repeat(120)}…`)
  assert.equal(agentEntry(session('B1@r', { last_text: '一行目\n二行目' }), false).last_text, '一行目')
  assert.equal(agentEntry(session('B1@r'), false, 123_456).context_tokens, 123_456, '相手が読み直す量（#311）')
  assert.equal(agentEntry(session('B1@r'), false).context_tokens, 0, '分からなければ 0')
})

test('tokensLabel: 万トークンに丸める。1 万未満は千、0 は空', () => {
  assert.equal(tokensLabel(123_456), '約 12 万トークン')
  assert.equal(tokensLabel(9_261_892), '約 926 万トークン')
  assert.equal(tokensLabel(4_200), '約 4 千トークン')
  assert.equal(tokensLabel(300), '約 1 千トークン')
  assert.equal(tokensLabel(0), '')
})

test('usageRefusal: 相手のエージェントの 5 時間の枠が 80%・週の枠が 95% を超えていたら送らない。戻った枠と取れない使用量では止めない（#311）', () => {
  const now = Date.UTC(2026, 8, 11, 3, 0, 0)
  const later = now / 1000 + 3600
  const earlier = now / 1000 - 60
  const claude = (primary: number, secondary = 10, resets = later): UsageResponse => ({
    claude: { primary: { used_percent: primary, window_minutes: 300, resets_at: resets }, secondary: { used_percent: secondary, window_minutes: 10080, resets_at: later }, at: '' },
  })
  assert.equal(usageRefusal(claude(AGENT_USAGE_STOP_PERCENT - 1), 'claude', now), '')
  assert.match(usageRefusal(claude(85.4), 'claude', now), /Claude の 5 時間の枠が 85% 使われているので送りません/)
  assert.equal(usageRefusal(claude(85, 10, earlier), 'claude', now), '', '枠が戻っていれば、その割合は古い')
  assert.match(usageRefusal(claude(10, AGENT_WEEKLY_STOP_PERCENT), 'claude', now), /週の枠が 95%/)
  assert.match(usageRefusal({ claude: { limited: { resets_at: later, kind: 'five_hour' }, at: '' } } as UsageResponse, 'claude', now), /上限に当たっている/)
  assert.equal(usageRefusal({ claude: { limited: { resets_at: earlier, kind: 'five_hour' }, at: '' } } as UsageResponse, 'claude', now), '', '上限から戻っていれば止めない')
  assert.equal(usageRefusal(claude(99), 'codex', now), '', '見るのは相手のエージェントの枠')
  assert.match(usageRefusal({ codex: { primary: { used_percent: 90, window_minutes: 300 }, at: '' } }, 'codex', now), /Codex の 5 時間の枠が 90%/)
  assert.equal(usageRefusal({}, 'claude', now), '', 'ステータスラインを配線していなければ取れない。材料が無いのに止めない')
  assert.equal(usageRefusal(claude(99), 'opencode', now), '')
})

test('budgetRefusal: このターンで読み直させた量に相手のぶんを足して、予算を超えるなら送らない（#311）', () => {
  assert.equal(budgetRefusal(0, 2_000_000), '')
  assert.equal(budgetRefusal(1_000_000, AGENT_TURN_READ_BUDGET - 1_000_000), '', 'ちょうど予算までは送れる')
  const over = budgetRefusal(2_000_000, 1_500_000)
  assert.match(over, /予算を超えます（これまで 約 200 万トークン、この相手は約 150 万トークン、予算は約 300 万トークン）/)
  assert.equal(budgetRefusal(2_900_000, 0), '', '相手の大きさが分からなければ止めない')
  assert.match(budgetRefusal(0, 5_000_000), /これまで 0、/, '1 回で予算を超える相手にも送らない')
})

test('deliveredFromTailnet: tailnet の MCP から来たメッセージも、同じ印と id で返答のターンを見つけられる（#312）', () => {
  const text = deliveredFromTailnet('me@example.com', 'abc123', '  見て  ')
  assert.ok(text.startsWith('【SAI】tailnet の「me@example.com」からのメッセージです（id: abc123）'))
  assert.ok(text.endsWith('\n\n見て'))
  assert.equal(isDeliveryOf(text, 'abc123'), true)
  assert.equal(isDeliveryOf(text, 'abc12'), false)
})

test('agentOverlap: どちらの worktree でも変わっているファイル。CLAUDE.md・README.md・docs/ は数えず、多ければ先頭と残りの数（#564）', () => {
  const mine = { root: '/w/a', paths: ['server/app.ts', 'shared/types.ts', 'CLAUDE.md', 'web/CLAUDE.md', 'README.md', 'docs/internals/agents.md'] }
  const theirs = { root: '/w/b', paths: ['shared/types.ts', 'server/app.ts', 'CLAUDE.md', 'web/CLAUDE.md', 'README.md', 'docs/internals/agents.md', 'web/src/App.tsx'] }
  assert.deepEqual(agentOverlap(mine, theirs), { overlap: ['server/app.ts', 'shared/types.ts'], overlap_more: 0 })
  assert.deepEqual(agentOverlap(mine, { ...theirs, root: '/w/a' }), { overlap: [], overlap_more: 0 }, '同じ worktree（トップが同じ）は差分が同じなので重なりではない')
  assert.deepEqual(agentOverlap({ root: '', paths: mine.paths }, theirs), { overlap: [], overlap_more: 0 }, 'トップが分からなければ出さない')
  const many = Array.from({ length: AGENT_OVERLAP_SHOW + 3 }, (_, i) => `src/f${i}.ts`)
  const got = agentOverlap({ root: '/w/a', paths: many }, { root: '/w/b', paths: [...many].reverse() })
  assert.equal(got.overlap.length, AGENT_OVERLAP_SHOW)
  assert.equal(got.overlap_more, 3)
  assert.deepEqual(got.overlap, [...many].sort().slice(0, AGENT_OVERLAP_SHOW), 'パスの順')
})

test('agentEntry: overlap を渡さなければ空（#564）', () => {
  const e = agentEntry({ id: 'B1@r', title: 't', project: 'o/r', branch: 'x', agent: 'claude', last_text: '' } as unknown as SessionSummary, false)
  assert.deepEqual([e.overlap, e.overlap_more], [[], 0])
})

test('withHandedReplies / splitHandedReplies: 返答を本文の頭に足し、画面では外せる。失敗は 1 行（#594）', () => {
  const t = withHandedReplies('579着手して', [
    { message_id: 'ab', to_name: 'かなで', status: 'done', text: 'PR #9 を出しました' },
    { message_id: 'cd', to_name: '明', status: 'failed', error: '終了コード 1' },
  ])
  assert.ok(t.startsWith(HANDED_MARK))
  assert.ok(!t.startsWith(AGENT_HEADER_MARK), '届けた見出し（【SAI】）と取り違えない')
  assert.equal(deliveredId(t), '', 'deliveredId() は返答の塊を「届いたメッセージ」と読まない')
  assert.match(t, /「明」（message_id: cd）への依頼は失敗しました: 終了コード 1/)
  assert.deepEqual(splitHandedReplies(t), { text: '579着手して', handed: 2 })
  assert.equal(withHandedReplies('そのまま', []), 'そのまま', '返答が無ければ本文だけ')
  assert.deepEqual(splitHandedReplies('人が 【SAI 返答】と打った'), { text: '人が 【SAI 返答】と打った', handed: 0 })
})

test('withHandedReplies: 件数と合計の字数に上限があり、入りきらない分は名前だけ 1 行（#594）', () => {
  const many = Array.from({ length: HANDED_MAX_ITEMS + 2 }, (_, i) => ({ message_id: `m${i}`, to_name: `s${i}`, status: 'done' as const, text: 'x' }))
  const t = withHandedReplies('本文', many)
  assert.equal((t.match(/からの返答:/g) ?? []).length, HANDED_MAX_ITEMS)
  assert.match(t, /ほか 2 件（本文は相手のセッションで読めます）: 「s8」（message_id: m8）、「s9」（message_id: m9）/)
  const big = Array.from({ length: 5 }, (_, i) => ({ message_id: `b${i}`, to_name: `s${i}`, status: 'done' as const, text: 'あ'.repeat(4000) }))
  const u = withHandedReplies('本文', big)
  assert.equal((u.match(/からの返答:/g) ?? []).length, Math.floor(HANDED_MAX_CHARS / 4050), `合計 ${HANDED_MAX_CHARS} 字まで`)
  assert.equal(splitHandedReplies(u).handed, 5, '数は足した全部（名前だけの分も渡した扱い）')
})

test('sendHow: sai_send の返事に、相手のターンをどう回したかを出す（#624）', () => {
  assert.match(sendHow('compact'), /要約（\/compact）してから始めます/)
  assert.match(sendHow('queued'), /終わってから回ります/)
  assert.equal(sendHow('process'), '相手のターンを始めました')
})

test('resolveTarget: id・表示名・worktree 名・題名の完全一致で、ちょうど 1 つのときだけ当てる（#625）', () => {
  const s = (id: string, repo: string, title: string, name = '') => ({ id, repo, title, ...(name ? { meta: { name } } : {}) }) as SessionSummary
  const targets = [s('a@dev-clared', 'dev-clared', '着手して', 'くらら'), s('b@dev-min', 'dev-min', '319 対応して', '明'), s('c@dev-x', 'dev-x', 'x', '明. - Avvy deco'), s('d@main', 'main', '一覧'), s('e@main', 'main', '取り次ぎ')]
  const idOf = (to: string) => resolveTarget(targets, to).target?.id
  assert.equal(idOf('a@dev-clared'), 'a@dev-clared')
  assert.equal(idOf('くらら'), 'a@dev-clared')
  assert.equal(idOf(' DEV-Clared '), 'a@dev-clared', '大文字小文字と前後の空白は無視')
  assert.equal(idOf('一覧'), 'd@main', '表示名が無ければ題名')
  assert.equal(idOf('明'), 'b@dev-min', '「明. - Avvy deco」とは取り違えない（完全一致だけ）')
  assert.equal(idOf('着手して'), undefined, '表示名のあるセッションは題名では引かない（題名は最初の入力で、他と重なりやすい）')
  assert.equal(idOf('くら'), undefined, '前方一致はしない')
  assert.equal(idOf(''), undefined)
  const dup = resolveTarget(targets, 'main')
  assert.ok(!dup.target && dup.ambiguous)
  assert.deepEqual(!dup.target && dup.candidates.map((c) => c.id), ['d@main', 'e@main'], '同じ worktree に 2 つ居れば当てず、当たった分を候補に')
  const none = resolveTarget(targets, 'だれか')
  assert.ok(!none.target && !none.ambiguous && none.candidates.length === targets.length, '無ければ送れる相手の全部を候補に')
  assert.match(targetRefusal('main', dup as never, '送れません'), /「main」に当たる相手が 2 つあります。[^\n]*\n- d@main「一覧」\n- e@main「取り次ぎ」/)
  assert.equal(targetRefusal('x', { target: null, ambiguous: false, candidates: [] }, '送れません'), '送れません')
  // 送れないセッションに同じ名前が居れば、送れる方が 1 つでも当てない（別の相手に黙って届かせない）
  const hidden = resolveTarget(targets, '明', [s('z@dev-z', 'dev-z', 'z', '明')])
  assert.ok(!hidden.target && hidden.ambiguous && hidden.hidden === 1)
  assert.match(targetRefusal('明', hidden as never, ''), /当たる相手が 2 つあります（うち 1 つは送れないセッション。下には送れる方だけ）。[^\n]*\n- b@dev-min「明」$/)
  assert.equal(resolveTarget(targets, 'b@dev-min', [s('z@dev-z', 'dev-z', 'z', '明')]).target?.id, 'b@dev-min', 'id なら今までどおり')
  assert.equal(resolveTarget(targets, 'だれか', [s('z@dev-z', 'dev-z', 'z', 'だれか')]).target, null)
  assert.deepEqual(targetNames(targets[0]!), ['a@dev-clared', 'くらら', 'dev-clared'])
})

test('replyOf / agentReplyRows: ターン完了の行の入力が要約の文に置き換わっていても、直前の入力の行の見出しで当てる（#626）', () => {
  const summary = `${COMPACT_SUMMARY_HEAD} that ran out of context. …`
  const sent = deliveredText({ label: '実装', project: 'o/r' }, 'a1', '見て')
  const rows = [
    { ts: '2026-09-11T01:00:00Z', session: 'B1', repo: 'r', event: 'UserPromptSubmit', user_text: sent, text: '' },
    { ts: '2026-09-11T01:01:00Z', session: 'B1', repo: 'r', event: 'PermissionRequest', user_text: sent, text: '許可待ち: Bash: ls' },
    { ts: '2026-09-11T01:01:30Z', session: 'B1', repo: 'r', event: 'UserPromptSubmit', text: '' },
    { ts: '2026-09-11T01:02:00Z', session: 'C1', repo: 'r', event: 'Stop', user_text: summary, text: '別のセッションの要約のターン' },
    { ts: '2026-09-11T01:04:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: summary, text: '見ました' },
    { ts: '2026-09-11T01:10:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: summary, text: '次のターン（入力の行が無い）' },
    { ts: '2026-09-11T01:20:00Z', session: 'B1', repo: 'r', event: 'UserPromptSubmit', user_text: '人が打った', text: '' },
    { ts: '2026-09-11T01:21:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: summary, text: '人の入力のターン' },
  ] as FeedRow[]
  assert.equal(replyOf(rows, 'B1@r', 'a1')?.text, '見ました', '合図だけの再開の行は見出しを消さない。当てるのは次のターン完了の 1 つだけ')
  assert.equal(replyOf(rows, 'C1@r', 'a1'), null, '別のセッションの行には当てない')
  const out = agentReplyRows([{ message_id: 'a1', to: 'B1@r', since: '2026-09-11T00:59:00Z' }], rows, (id) => id)
  assert.deepEqual(out.map((r) => r.text), ['見ました'])

  // 入力が要約でないターン（バックグラウンドの通知で回った・人が打った）は救わない
  const plain = [
    { ts: '2026-09-11T01:00:00Z', session: 'B1', repo: 'r', event: 'UserPromptSubmit', user_text: sent, text: '' },
    { ts: '2026-09-11T01:04:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: '', text: '通知のターン' },
    { ts: '2026-09-11T01:05:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: '人が打った', text: '別のターン' },
    { ts: '2026-09-11T01:06:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: summary, text: 'さらに後の、要約が入ったターン' },
  ] as FeedRow[]
  assert.equal(replyOf(plain, 'B1@r', 'a1'), null, '入力の行の見出しは、次のターン完了の 1 つにだけ使う')
})

test('isCompactSummaryText: 要約の決まり文句で始まる入力だけ', () => {
  assert.equal(isCompactSummaryText(`${COMPACT_SUMMARY_HEAD} that ran out of context.`), true)
  assert.equal(isCompactSummaryText(`\n  ${COMPACT_SUMMARY_HEAD}`), true)
  assert.equal(isCompactSummaryText(`要約に「${COMPACT_SUMMARY_HEAD}」と出る`), false, '途中に出てくるだけの文は人の入力')
  assert.equal(isCompactSummaryText(''), false)
  assert.equal(isCompactSummaryText(undefined), false)
})
