import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_TURN_READ_BUDGET,
  AGENT_USAGE_STOP_PERCENT,
  AGENT_WEEKLY_STOP_PERCENT,
  AGENT_OVERLAP_SHOW,
  agentEntry,
  agentOverlap,
  AGENT_REQUEST_MAX,
  agentReplyRows,
  requestRefusal,
  followupHead,
  followupReplyRows,
  replierName,
  acrossEntry,
  acrossLabel,
  acrossNames,
  agentTargets,
  isAcross,
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
  const out = agentReplyRows(sent, rows, (id) => (id === 'B1@r' ? 'セッション B' : id))
  assert.deepEqual(out.map((r) => [r.text, r.agent_reply?.message_id, r.agent_reply?.to_name]), [
    ['別件の返答', 'c3d4', 'セッション B'],
    ['着手しました', 'a1b2', 'セッション B'],
  ], '入力の行・別の相手・2 本目・まだ返っていないものは入れない。古い順')
  assert.equal(out[1]?.agent_reply?.sent_at, '2026-09-30T16:21:56Z')
  assert.deepEqual(agentReplyRows([], rows, (id) => id), [])
  // 相手のアイコン（#666）。あれば印に載せ、無ければキーごと載せない
  assert.ok(out.every((r) => !('to_icon' in r.agent_reply!)))
  const iconed = agentReplyRows(sent, rows, (id) => id, (id) => (id === 'B1@r' ? '/api/sessions/B1%40r/icon?v=1' : undefined))
  assert.deepEqual(iconed.map((r) => r.agent_reply?.to_icon), ['/api/sessions/B1%40r/icon?v=1', '/api/sessions/B1%40r/icon?v=1'])
  assert.ok(agentReplyRows(sent, rows, (id) => id, () => '').every((r) => !('to_icon' in r.agent_reply!)), '空の URL も載せない')
})

test('replierName: 表示名があればそれ。題名が届けた見出しなら worktree 名（#588）', () => {
  const s = (over: Partial<SessionSummary>) => ({ id: 'B1@dev-worktree-b', title: '', repo: 'dev-worktree-b', ...over }) as SessionSummary
  assert.equal(replierName(s({ meta: { name: 'セッション B' }, title: '【SAI】#o/r の「x」からのメッセージです' })), 'セッション B')
  assert.equal(replierName(s({ title: '【SAI】#o/r の「x」からのメッセージです' })), '#dev-worktree-b')
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
  // 人が許した組の先のリポジトリ（#747）も相手になる。向きつきで、同じ project が先。素通しでも・別のマシンや合成 ID は今までどおり落ちる
  const across = [{ from: 'o/r', to: 'o/other' }]
  const more = [...sessions, session('E1@r', { project: 'o/other', host: 'mini' }), session('F1@r', { project: 'o/other', meta: { permission_mode: 'bypassPermissions' } }), session('G1@r', { project: 'o/third' })]
  assert.deepEqual(agentTargets(more, from, 'testmac', across).map((s) => s.id), ['B1@r', 'C1@r', 'F1@r'])
  assert.deepEqual(agentTargets(more, session('C1@r', { project: 'o/other' }), 'testmac', across).map((s) => s.id), ['F1@r'], '逆向き（o/other → o/r）は許していない')
  assert.equal(isAcross(from, more[2]!, across), true)
  assert.equal(isAcross(from, more[1]!, across), false, '同じ project は「またぐ」ではない')
  assert.deepEqual(acrossEntry(session('C1@r', { project: 'o/other', repo: 'r', branch: 'secret-branch', last_text: '中身' }), true, false), { id: 'C1@r', name: '#r', project: 'o/other', branch: '', agent: 'claude', busy: true, last_text: '', context_tokens: 0, overlap: [], overlap_more: 0, across: true }, '出すのは呼び名・エージェント・空いているか、まで')
  assert.deepEqual(acrossEntry(session('C1@r', { project: 'o/other' }), false, true).holding, { free: true })
  // 呼び名は人が付けた表示名だけ。無ければ #<worktree 名>（題名＝相手のリポジトリの人の入力には落とさない）
  assert.equal(acrossLabel(session('C1@r', { meta: { name: '担当' } })), '担当')
  assert.equal(acrossLabel(session('C1@r', { repo: 'r' })), '#r')
  assert.equal(acrossLabel(session('C1@r', { repo: '' })), 'C1@r', 'worktree 名も無ければ id')
  assert.deepEqual(acrossNames(session('C1@r', { meta: { name: '担当' } })), ['c1@r', '担当'], 'worktree 名と題名では指せない')
  assert.deepEqual(acrossNames(session('C1@r')), ['c1@r'])
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
    { message_id: 'ab', to_name: 'セッション C', status: 'done', text: 'PR #9 を出しました' },
    { message_id: 'cd', to_name: 'セッション B', status: 'failed', error: '終了コード 1' },
  ])
  assert.ok(t.startsWith(HANDED_MARK))
  assert.ok(!t.startsWith(AGENT_HEADER_MARK), '届けた見出し（【SAI】）と取り違えない')
  assert.equal(deliveredId(t), '', 'deliveredId() は返答の塊を「届いたメッセージ」と読まない')
  assert.match(t, /「セッション B」（message_id: cd）への依頼は失敗しました: 終了コード 1/)
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
  const targets = [s('a@dev-worktree-a', 'dev-worktree-a', '着手して', 'セッション A'), s('b@dev-worktree-b', 'dev-worktree-b', '319 対応して', 'セッション B'), s('c@dev-x', 'dev-x', 'x', 'セッション B - 別件'), s('d@main', 'main', '一覧'), s('e@main', 'main', '取り次ぎ')]
  const idOf = (to: string) => resolveTarget(targets, to).target?.id
  assert.equal(idOf('a@dev-worktree-a'), 'a@dev-worktree-a')
  assert.equal(idOf('セッション A'), 'a@dev-worktree-a')
  assert.equal(idOf(' DEV-Worktree-A '), 'a@dev-worktree-a', '大文字小文字と前後の空白は無視')
  assert.equal(idOf('一覧'), 'd@main', '表示名が無ければ題名')
  assert.equal(idOf('セッション B'), 'b@dev-worktree-b', '「セッション B - 別件」とは取り違えない（完全一致だけ）')
  assert.equal(idOf('着手して'), undefined, '表示名のあるセッションは題名では引かない（題名は最初の入力で、他と重なりやすい）')
  assert.equal(idOf('セッション'), undefined, '前方一致はしない')
  assert.equal(idOf(''), undefined)
  const dup = resolveTarget(targets, 'main')
  assert.ok(!dup.target && dup.ambiguous)
  assert.deepEqual(!dup.target && dup.candidates.map((c) => c.id), ['d@main', 'e@main'], '同じ worktree に 2 つ居れば当てず、当たった分を候補に')
  const none = resolveTarget(targets, 'だれか')
  assert.ok(!none.target && !none.ambiguous && none.candidates.length === targets.length, '無ければ送れる相手の全部を候補に')
  assert.match(targetRefusal('main', dup as never, '送れません'), /「main」に当たる相手が 2 つあります。[^\n]*\n- d@main「一覧」\n- e@main「取り次ぎ」/)
  assert.equal(targetRefusal('x', { target: null, ambiguous: false, candidates: [] }, '送れません'), '送れません')
  // 送れないセッションに同じ名前が居れば、送れる方が 1 つでも当てない（別の相手に黙って届かせない）
  const hidden = resolveTarget(targets, 'セッション B', [s('z@dev-z', 'dev-z', 'z', 'セッション B')])
  assert.ok(!hidden.target && hidden.ambiguous && hidden.hidden === 1)
  assert.match(targetRefusal('セッション B', hidden as never, ''), /当たる相手が 2 つあります（うち 1 つは送れないセッション。下には送れる方だけ）。[^\n]*\n- b@dev-worktree-b「セッション B」$/)
  assert.equal(resolveTarget(targets, 'b@dev-worktree-b', [s('z@dev-z', 'dev-z', 'z', 'セッション B')]).target?.id, 'b@dev-worktree-b', 'id なら今までどおり')
  assert.equal(resolveTarget(targets, 'だれか', [s('z@dev-z', 'dev-z', 'z', 'だれか')]).target, null)
  assert.deepEqual(targetNames(targets[0]!), ['a@dev-worktree-a', 'セッション a', 'dev-worktree-a'])
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

test('replyOf: 届けたターンが終わったと分かる行（入力待ち）のあとの、要約が入ったターンには当てない（#626）', () => {
  const summary = `${COMPACT_SUMMARY_HEAD} that ran out of context. …`
  const sent = deliveredText({ label: '実装', project: 'o/r' }, 'a1', '見て')
  const rows = [
    { ts: '2026-09-11T01:00:00Z', session: 'B1', repo: 'r', event: 'UserPromptSubmit', user_text: sent, text: '' },
    // 届けたターンのターン完了の行は落ちた。60 秒あとに「入力待ち」だけが来る
    { ts: '2026-09-11T01:05:00Z', session: 'B1', repo: 'r', event: 'Notification', text: '入力待ち: Claude is waiting for your input' },
    { ts: '2026-09-11T02:00:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: summary, text: '通知で回った、関係の無いターン' },
  ] as FeedRow[]
  assert.equal(replyOf(rows, 'B1@r', 'a1'), null)
})

test('isCompactSummaryText: 要約の決まり文句で始まる入力だけ', () => {
  assert.equal(isCompactSummaryText(`${COMPACT_SUMMARY_HEAD} that ran out of context.`), true)
  assert.equal(isCompactSummaryText(`\n  ${COMPACT_SUMMARY_HEAD}`), true)
  assert.equal(isCompactSummaryText(`要約に「${COMPACT_SUMMARY_HEAD}」と出る`), false, '途中に出てくるだけの文は人の入力')
  assert.equal(isCompactSummaryText(''), false)
  assert.equal(isCompactSummaryText(undefined), false)
})

test('followupReplyRows: 人が返答のバブルの下から送った返信に、相手がその文で回したターンの返答を当てる（#700）', () => {
  const rows = [
    { ts: '2026-10-05T03:00:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: 'マージして', text: '送る前のターン' },
    { ts: '2026-10-05T03:11:00Z', session: 'B1', repo: 'r', event: 'UserPromptSubmit', user_text: 'マージして', text: '' },
    { ts: '2026-10-05T03:12:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: '前から回っていたターン', text: '預かりの前に終わった別のターン' },
    { ts: '2026-10-05T03:13:00Z', session: 'C1', repo: 'r', event: 'Stop', user_text: 'マージして', text: '別の相手' },
    { ts: '2026-10-05T03:14:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: 'マージして\n\n/tmp/a.png', text: 'マージしました' },
    { ts: '2026-10-05T03:20:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: 'マージして', text: '2 回目のマージ' },
    { ts: '2026-10-05T03:30:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: 'マージして', text: '当てる返信がもう無い' },
    { ts: '2026-10-05T03:40:00Z', session: 'B1', repo: 'r', event: 'Stop', user_text: withHandedReplies('返答の塊のあと', [{ message_id: 'm9', to_name: 'セッション B', status: 'done', text: '済み' }]), text: '頭に返答を足されたターン' },
  ] as FeedRow[]
  const followups = [
    { id: 'f2', to: 'B1@r', text: 'マージして', at: '2026-10-05T03:15:00Z' },
    { id: 'f1', to: 'B1@r', text: ' マージして ', at: '2026-10-05T03:10:00Z' },
    { id: 'f3', to: 'B1@r', text: 'まだ返っていない', at: '2026-10-05T03:16:00Z' },
    { id: 'f4', to: 'B1@r', text: '   ', at: '2026-10-05T03:00:00Z' },
    { id: 'f5', to: 'B1@r', text: '返答の塊のあと', at: '2026-10-05T03:35:00Z' },
  ]
  const out = followupReplyRows(followups, rows, () => 'セッション B', () => '/icon')
  assert.deepEqual(out.rows.map((r) => [r.text, r.agent_reply?.message_id]), [['マージしました', 'f1'], ['2 回目のマージ', 'f2'], ['頭に返答を足されたターン', 'f5']], 'SAI が頭に足した返答の塊（#594）は外して比べる。送る前・入力の行・別の入力・別の相手は当てない。同じ文は古い順に 1 つずつ')
  assert.deepEqual(out.rows[0]?.agent_reply, { message_id: 'f1', to_name: 'セッション B', to_icon: '/icon', sent_at: '2026-10-05T03:10:00Z', followup: true })
  assert.deepEqual([...out.answered], [['f1', '2026-10-05T03:14:00Z'], ['f2', '2026-10-05T03:20:00Z'], ['f5', '2026-10-05T03:40:00Z']])
  assert.deepEqual(followupReplyRows([], rows, (id) => id).rows, [])
})

test('followupHead: 画面に出すのは 1 行目の頭だけ（#700）', () => {
  assert.equal(followupHead('  マージして\n2 行目'), 'マージして')
  assert.equal(followupHead('あ'.repeat(41)), `${'あ'.repeat(40)}…`)
  assert.equal(followupHead('あ'.repeat(40)), 'あ'.repeat(40))
})

test('requestRefusal: 依頼 1 つの件数と、読み直させる量の合計の上限。超えたら宛先ごとの量を言う（#727）', () => {
  const small = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `相手${i}`, tokens: 100_000 }))
  assert.equal(requestRefusal(3, 300_000, small(AGENT_REQUEST_MAX - 3)), '')
  assert.match(requestRefusal(3, 0, small(AGENT_REQUEST_MAX - 2)), new RegExp(`${AGENT_REQUEST_MAX} 件まで.*1 件も預かっていません`))
  assert.equal(requestRefusal(0, 2_000_000, [{ name: '甲', tokens: 4_000_000 }]), '', 'ちょうどは通す')
  const over = requestRefusal(1, 2_000_000, [{ name: '甲', tokens: 2_500_000 }, { name: '乙', tokens: 2_000_000 }, { name: '丙', tokens: 0 }])
  assert.match(over, /合計が予算を超えます（これまで 約 200 万トークン、今回 約 450 万トークン＝甲 約 250 万トークン、乙 約 200 万トークン。予算は約 600 万トークン）/)
  assert.match(over, /1 件も預かっていません/)
  assert.equal(requestRefusal(0, 5_900_000, [{ name: '甲', tokens: 0 }]), '', '大きさの分からない相手は足さない')
})

test('targetRefusal: 送り元と違うリポジトリの候補には <リポジトリ> を添える（#747。呼び名がリポジトリをまたいで重なる）', () => {
  const mk = (id: string, project: string) => ({ id, project, title: '', repo: 'r', meta: { name: '同じ名前' } }) as unknown as SessionSummary
  const text = targetRefusal('同じ名前', { target: null, ambiguous: true, candidates: [mk('B1@r', 'o/r'), mk('C1@r', 'o/other')] }, '', 'o/r')
  assert.match(text, /当たる相手が 2 つあります。送っていません/)
  assert.ok(text.includes('- B1@r「同じ名前」\n- C1@r「同じ名前」（o/other）'), text)
  // 別のリポジトリの候補に表示名が無ければ、題名ではなく #<worktree 名>
  const untitled = { id: 'C2@x', project: 'o/other', title: '相手のリポジトリの人の入力', repo: 'x' } as unknown as SessionSummary
  assert.ok(targetRefusal('x', { target: null, ambiguous: false, candidates: [untitled] }, '送れません', 'o/r').includes('- C2@x「#x」（o/other）'))
  assert.ok(!targetRefusal('x', { target: null, ambiguous: true, candidates: [mk('B1@r', 'o/r')] }, '').includes('（o/r）'), '送り元のリポジトリを渡さなければ今までどおり')
})

test('requestRefusal: 別のリポジトリの相手が混ざる依頼では、相手ごとの量も合計も出さない（#747）', () => {
  const text = requestRefusal(0, 0, [{ name: '甲', tokens: 4_000_000 }, { name: '別のリポジトリの相手', tokens: 3_000_000, hidden: true }])
  assert.match(text, /合計が予算を超えます（予算は約 600 万トークン。別のリポジトリの相手の量は出しません）/)
  assert.doesNotMatch(text, /400 万|300 万|700 万|甲/)
  // これまでの合計に伏せた分が入っているとき（同じターンで先に別のリポジトリへ送った）も、合計を出さない（引き算で分かる）
  const later = requestRefusal(1, 3_000_000, [{ name: '甲', tokens: 4_000_000 }], true)
  assert.match(later, /別のリポジトリの相手の量は出しません/)
  assert.doesNotMatch(later, /これまで|300 万|400 万/)
})

test('resolveTarget: 名前の引き方を相手ごとに変えられる（別のリポジトリの相手は id と表示名だけ。#747）', () => {
  const near = session('B1@r', { repo: 'main' })
  const far = session('C1@x', { project: 'o/other', repo: 'main', meta: { name: '担当' } })
  const namesOf = (s: SessionSummary) => (s.project === 'o/other' ? acrossNames(s) : targetNames(s))
  assert.equal((resolveTarget([near, far], 'main', [], namesOf) as { target: SessionSummary }).target.id, 'B1@r', 'worktree 名は同じリポジトリの相手にだけ当たる')
  assert.equal(resolveTarget([far], 'main', [], namesOf).target, null, '別のリポジトリの相手しか居なければ、worktree 名では当てない')
  assert.equal((resolveTarget([near, far], '担当', [], namesOf) as { target: SessionSummary }).target.id, 'C1@x')
})
