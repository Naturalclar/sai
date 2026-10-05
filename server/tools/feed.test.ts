// `~/.agent-feed` を読む道具（#703）。**本物の置き場は触らない**（一時ディレクトリに記録を置く）。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { deliveredText, withHandedReplies } from '../../shared/agentMessages.ts'
import { COMPACT_SUMMARY_HEAD } from '../../shared/compactSummary.ts'
import type { FeedRow } from '../../shared/types.ts'
import { head, run, table } from './feed.ts'
import {
  dateRange,
  datesBetween,
  feedDir,
  humanPrompt,
  isDate,
  messageReplies,
  pairTurns,
  promptKind,
  readAgentMessages,
  readMeta,
  readRows,
  readTurnUsage,
  resolveSession,
  rowEntity,
  sessionsOf,
  usageRows,
  usageTotals,
} from './feedRead.ts'

const NOW = new Date('2026-10-05T03:00:00Z') // 10/5 12:00（Asia/Tokyo）
const SUMMARY = `${COMPACT_SUMMARY_HEAD} that ran out of context.`
const MESSAGE_ID = '6a7abd277c1e8fcc'

const row = (ts: string, session: string, repo: string, event: string, rest: Partial<FeedRow> = {}): FeedRow =>
  ({ ts, agent: 'claude', repo, branch: 'main', session, event, cwd: `/work/${repo}`, project: 'acme/app', ...rest }) as FeedRow

/** 10/4 と 10/5 の記録。alpha は 2 ターン（2 つ目は途中で要約が入った）、beta はメッセージで回った 1 ターン */
const DAY4: FeedRow[] = [
  row('2026-10-04T10:00:00+09:00', 'aaaa1111', 'dev-a', 'UserPromptSubmit', { user_text: 'テストを直して' }),
  row('2026-10-04T10:05:00+09:00', 'aaaa1111', 'dev-a', 'Stop', { user_text: 'テストを直して', text: '直しました。' }),
]
const DAY5: FeedRow[] = [
  row('2026-10-05T09:00:00+09:00', 'aaaa1111', 'dev-a', 'UserPromptSubmit', { user_text: '続きをお願い' }),
  row('2026-10-05T09:30:00+09:00', 'aaaa1111', 'dev-a', 'Stop', { user_text: SUMMARY, text: '続きを終えました。' }),
  row('2026-10-05T10:00:00+09:00', 'bbbb2222', 'dev-b', 'UserPromptSubmit', { user_text: deliveredText({ label: 'alpha', project: 'acme/app' }, MESSAGE_ID, '#1 に着手してください。') }),
  row('2026-10-05T10:20:00+09:00', 'bbbb2222', 'dev-b', 'Stop', { user_text: deliveredText({ label: 'alpha', project: 'acme/app' }, MESSAGE_ID, '#1 に着手してください。'), text: 'PR を出しました。' }),
  row('2026-10-05T11:00:00+09:00', 'aaaa1111', 'dev-a', 'UserPromptSubmit', { user_text: 'まだ終わっていない依頼' }),
]
/** 別のマシンのぶん（`<host>` 付きのファイル） */
const DAY5_OTHER: FeedRow[] = [row('2026-10-05T08:00:00+09:00', 'cccc3333', 'dev-a', 'Stop', { user_text: '別のマシン', text: '終わり。', host: 'other' })]

/** 同じセッションの `cost_usd` は積み上げ（1 → 3 → 6）。1 ターンぶんは 1・2・3 で、合計は 6（積み上げのまま足すと 10） */
const USAGE = [
  { ts: '2026-10-04T01:05:00Z', id: 'aaaa1111@dev-a', cost_usd: 1 },
  { ts: '2026-10-05T00:30:00Z', id: 'aaaa1111@dev-a', cost_usd: 3 },
  { ts: '2026-10-05T01:20:00Z', id: 'bbbb2222@dev-b', cost_usd: 0.5 },
  { ts: '2026-10-05T02:00:00Z', id: 'aaaa1111@dev-a', cost_usd: 6 },
].map((e) => ({ model: 'claude-opus', input_tokens: 100, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, duration_ms: 1000, num_turns: 1, denials: 0, is_error: false, ...e }))

const MESSAGES = {
  messages: [
    { message_id: MESSAGE_ID, from: 'aaaa1111@dev-a', to: 'bbbb2222@dev-b', text: '#1 に着手してください。', since: '2026-10-05T01:00:00.000Z' },
    { message_id: 'ffff000000000000', from: 'aaaa1111@dev-a', to: 'bbbb2222@dev-b', text: 'もう 1 つ', since: '2026-10-05T02:30:00.000Z' },
    // 返答の行は記録に無いが、送り元には渡してある（完了の行が落ちて補った返答。#614）
    { message_id: 'eeee000000000000', from: 'bbbb2222@dev-b', to: 'aaaa1111@dev-a', text: '補った返答で返ったもの', since: '2026-10-05T02:40:00.000Z', handed_at: '2026-10-05T02:50:00.000Z' },
    // 形の壊れた 1 件は読まない
    { message_id: 'dddd000000000000', from: 'x', to: 'y' },
  ],
  sends: {},
  origins: {},
  stopped: [],
}

let dir = ''
const jsonl = (rows: readonly unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-feed-tool-'))
  await writeFile(join(dir, '2026-10-04.jsonl'), jsonl(DAY4))
  // 置き場を cwd にした行（一言を作る子のターン）は SAI 自身の雑音
  await writeFile(join(dir, '2026-10-05.jsonl'), jsonl([...DAY5, row('2026-10-05T09:10:00+09:00', 'noise', 'agent-feed', 'Stop', { cwd: dir, text: '一言' })]) + '壊れた行\n')
  await writeFile(join(dir, '2026-10-05.other.jsonl'), jsonl(DAY5_OTHER))
  // `ts` が読めない行はサーバと同じく落とす
  await writeFile(join(dir, 'turn-usage.jsonl'), jsonl([...USAGE, { ...USAGE[0], ts: 'いつか', cost_usd: 99 }]))
  await writeFile(join(dir, 'agent-messages.json'), JSON.stringify(MESSAGES))
  await writeFile(join(dir, 'session-meta.json'), JSON.stringify({ 'aaaa1111@dev-a': { name: 'alpha' }, 'bbbb2222@dev-b': { name: 'beta' } }))
  await mkdir(join(dir, 'session-icons'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

const all = { from: '2026-10-04', to: '2026-10-05' }

async function cli(...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = []
  const err: string[] = []
  const code = await run(argv, { dir, now: NOW, out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out, err }
}

test('置き場は AGENT_FEED_DIR に従う（無ければ ~/.agent-feed）', () => {
  assert.equal(feedDir({ AGENT_FEED_DIR: '/tmp/x-feed' }), '/tmp/x-feed')
  assert.match(feedDir({}), /\/\.agent-feed$/)
})

test('日付の範囲は Asia/Tokyo で切り、両端を含む', () => {
  assert.deepEqual(datesBetween('2026-09-30', '2026-10-02'), ['2026-09-30', '2026-10-01', '2026-10-02'])
  assert.deepEqual(datesBetween('2026-10-02', '2026-10-01'), [])
  // 存在しない日付は通さない（Date は 2/31 を 3/3 に読んでしまう）
  assert.deepEqual([isDate('2026-02-28'), isDate('2026-02-31'), isDate('2026-13-01'), isDate('10/5')], [true, false, false, false])
  // UTC ではまだ 10/4 でも、東京では 10/5
  assert.deepEqual(dateRange({ days: 2 }, new Date('2026-10-04T16:00:00Z')), { from: '2026-10-04', to: '2026-10-05' })
  assert.deepEqual(dateRange({ from: '2026-10-01' }, NOW), { from: '2026-10-01', to: '2026-10-05' })
})

test('行は範囲の日付だけを古い順に読み、<host> 付きも拾い、壊れた行と SAI 自身の雑音は落とす', async () => {
  const rows = await readRows(dir, all)
  assert.equal(rows.length, DAY4.length + DAY5.length + DAY5_OTHER.length)
  assert.deepEqual(rows.map((r) => r.ts), [...rows.map((r) => r.ts)].sort())
  assert.ok(rows.some((r) => r.host === 'other'))
  assert.ok(!rows.some((r) => r.session === 'noise'))
  assert.equal((await readRows(dir, { from: '2026-10-04', to: '2026-10-04' })).length, DAY4.length)
  assert.deepEqual(await readRows(join(dir, 'nowhere'), all), [])
})

test('要約の文と届いたメッセージは人の入力に数えない（#609 の数え間違い）', async () => {
  assert.equal(promptKind(SUMMARY), 'compact')
  assert.equal(humanPrompt(SUMMARY), '')
  assert.equal(promptKind(DAY5[2]!.user_text), 'message')
  assert.equal(promptKind('  '), 'empty')
  // ターン完了の行の入力を素直に数えると 4 つだが、人が打ったのは 2 つ（1 つは要約、1 つは届いたメッセージ）
  const turns = (await readRows(dir, all)).filter((r) => r.event === 'Stop' && r.session !== 'cccc3333')
  assert.equal(turns.length, 3)
  assert.deepEqual(turns.map((r) => humanPrompt(r.user_text)).filter(Boolean), ['テストを直して'])
})

test('入力の行と完了の行を対応付ける（要約で置き換わった入力は入力の行から採る）', async () => {
  const pairs = pairTurns(await readRows(dir, all)).filter((p) => p.entity === 'aaaa1111@dev-a')
  assert.deepEqual(pairs.map((p) => [p.state, p.kind, p.user_text]), [
    ['done', 'human', 'テストを直して'],
    ['done', 'human', '続きをお願い'],
    ['open', 'human', 'まだ終わっていない依頼'],
  ])
  assert.equal(pairs[1]!.stop!.user_text, SUMMARY)
})

test('完了の行が落ちたターン・本文が空のターンが分かる', () => {
  const rows = [
    row('2026-10-05T09:00:00+09:00', 's', 'r', 'UserPromptSubmit', { user_text: '落ちる' }),
    row('2026-10-05T09:10:00+09:00', 's', 'r', 'UserPromptSubmit', { user_text: '空で終わる' }),
    row('2026-10-05T09:20:00+09:00', 's', 'r', 'Stop', { user_text: '空で終わる', text: '' }),
    row('2026-10-05T09:30:00+09:00', 's', 'r', 'UserPromptSubmit', { user_text: '終了で落ちる' }),
    row('2026-10-05T09:40:00+09:00', 's', 'r', 'SessionEnd', { text: 'other' }),
    // 入力の行が無い経路（完了の行だけ）
    row('2026-10-05T09:50:00+09:00', 's', 'r', 'Stop', { user_text: '行だけ', text: '済み' }),
    // 完了の行の入力が空（`record.py` は無いときも `""` を書く）なら、入力の行から採る
    row('2026-10-05T10:00:00+09:00', 's', 'r', 'UserPromptSubmit', { user_text: '完了の行では空' }),
    row('2026-10-05T10:10:00+09:00', 's', 'r', 'Stop', { user_text: '', text: '済み' }),
  ]
  assert.deepEqual(pairTurns(rows).map((p) => [p.state, p.user_text, !!p.prompt, !!p.stop]), [
    ['missing', '落ちる', true, false],
    ['empty', '空で終わる', true, true],
    ['missing', '終了で落ちる', true, false],
    ['done', '行だけ', false, true],
    ['done', '完了の行では空', true, true],
  ])
  assert.equal(pairTurns(rows).at(-1)!.kind, 'human')
})

test('費用は前の行との差で数える（積み上げのまま足さない。#579 の数え間違い）', async () => {
  const entries = await readTurnUsage(dir)
  const rows = usageRows(entries)
  assert.deepEqual(rows.map((r) => r.turn_cost_usd), [1, 2, 0.5, 3])
  const bySession = usageTotals(rows, 'session')
  // 積み上げのまま足すと 1 + 3 + 6 = 10 になる
  assert.deepEqual(bySession.map((t) => [t.key, t.turns, t.cost_usd]), [['aaaa1111@dev-a', 3, 6], ['bbbb2222@dev-b', 1, 0.5]])
  assert.deepEqual(usageTotals(rows, 'day').map((t) => [t.key, t.cost_usd]), [['2026-10-04', 1], ['2026-10-05', 5.5]])
  assert.equal(bySession[0]!.output_tokens, 6000)
})

test('セッションの指定は ID・表示名・worktree 名・ID の頭で引き、決まらなければ候補を返す', async () => {
  const sessions = sessionsOf(await readRows(dir, all), await readMeta(dir))
  const id = (q: string) => {
    const r = resolveSession(sessions, q)
    return r.target ? r.target.id : r.candidates.map((s) => s.id).sort()
  }
  assert.equal(id('bbbb2222@dev-b'), 'bbbb2222@dev-b')
  assert.equal(id(' Beta '), 'bbbb2222@dev-b')
  assert.equal(id('dev-b'), 'bbbb2222@dev-b')
  assert.equal(id('bbbb'), 'bbbb2222@dev-b')
  // dev-a には 2 つある（別のマシンのぶんも）ので当てない
  assert.deepEqual(id('dev-a'), ['aaaa1111@dev-a', 'cccc3333@dev-a'])
  assert.equal(resolveSession(sessions, 'dev-a').target, null)
  // 短すぎる頭・どれにも当たらない名前は当てず、候補は全部
  assert.equal((id('bbb') as string[]).length, 3)
  assert.equal((id('nobody') as string[]).length, 3)
})

test('同じ名前でも、アーカイブしていない方が 1 つならそれを採る', () => {
  const rows = [row('2026-10-04T10:00:00+09:00', 'old', 'wt', 'Stop', { text: 'a' }), row('2026-10-05T10:00:00+09:00', 'new', 'wt', 'Stop', { text: 'b' })]
  const sessions = sessionsOf(rows, { 'old@wt': { archived_at: '2026-10-04T12:00:00.000Z' } })
  const r = resolveSession(sessions, 'wt')
  assert.equal(r.target?.id, 'new@wt')
  // アーカイブ済みしか当たらなければ、そちらを返す
  assert.equal(resolveSession(sessions, 'old@wt').target?.id, 'old@wt')
})

test('送ったメッセージと返答を引き当てる（返答が無ければ null）', async () => {
  const replies = messageReplies(await readAgentMessages(dir), await readRows(dir, all))
  assert.deepEqual(replies.map((r) => [r.message.message_id, r.state, r.reply?.text ?? null, r.reply ? rowEntity(r.reply) : null]), [
    [MESSAGE_ID, 'replied', 'PR を出しました。', 'bbbb2222@dev-b'],
    ['ffff000000000000', 'none', null, null],
    // 行は無いが送り元には渡してある（未着ではない）
    ['eeee000000000000', 'handed', null, null],
  ])
})

test('表は全角を 2 桁で数えて列を揃え、頭は 1 行にして幅で切る', () => {
  assert.deepEqual(table(['名前', 'x'], [['あい', '1'], ['abc', '2']]), ['名前  x', 'あい  1', 'abc   2'])
  assert.equal(head('  1 行目\n2 行目  ', 0), '1 行目 2 行目')
  assert.equal(head('あいうえお', 6), 'あい…')
  assert.equal(head('abc', 6), 'abc')
})

test('rows: 既定は数行に絞り、絞ったことを書く。--all で全部', async () => {
  const short = await cli('rows', 'alpha', '--days', '2', '-n', '2')
  assert.equal(short.code, 0)
  assert.match(short.out[0]!, /^aaaa1111@dev-a「alpha」 2 \/ 5 行（--all で全部）・2026-10-04〜2026-10-05$/)
  assert.equal(short.out.length, 4) // 見出し + 表の頭 + 2 行
  assert.match(short.out[2]!, /^10-05 09:30 {2}turn {4}\[要約\] This session/)
  assert.match(short.out[3]!, /^10-05 11:00 {2}resume {2}まだ終わっていない依頼$/)
  const full = await cli('rows', 'alpha', '--days', '2', '--all')
  assert.match(full.out[0]!, /」 5 行・/)
  assert.equal(full.out.length, 7)
})

test('rows: 既定の範囲は直近 7 日。--json は同じ中身を機械向けに出す', async () => {
  const { code, out } = await cli('rows', 'aaaa', '--json', '-n', '1')
  assert.equal(code, 0)
  const body = JSON.parse(out.join('')) as { id: string; total: number; range: unknown; rows: { kind: string; user_text: string }[] }
  assert.equal(body.id, 'aaaa1111@dev-a')
  assert.equal(body.total, 5)
  assert.deepEqual(body.range, { from: '2026-09-29', to: '2026-10-05' })
  assert.deepEqual(body.rows.map((r) => [r.kind, r.user_text]), [['resume', 'まだ終わっていない依頼']])
})

test('rows: 長い本文は切り、--full で切らない', async () => {
  const long = 'あ'.repeat(200)
  const other = await mkdtemp(join(tmpdir(), 'sai-feed-tool-long-'))
  try {
    await writeFile(join(other, '2026-10-05.jsonl'), jsonl([row('2026-10-05T09:00:00+09:00', 'long', 'r', 'Stop', { user_text: 'q', text: `${long}\n2 行目` })]))
    const io = { dir: other, now: NOW, err: () => {} }
    const lines: string[] = []
    await run(['rows', 'long@r', '--json'], { ...io, out: (l) => lines.push(l) })
    const clipped = (JSON.parse(lines[0]!) as { rows: { text: string }[] }).rows[0]!.text
    assert.ok(clipped.length < 40 && clipped.endsWith('…'))
    lines.length = 0
    await run(['rows', 'long@r', '--json', '--full'], { ...io, out: (l) => lines.push(l) })
    assert.equal((JSON.parse(lines[0]!) as { rows: { text: string }[] }).rows[0]!.text, `${long}\n2 行目`)
  } finally {
    await rm(other, { recursive: true, force: true })
  }
})

test('rows: 決まらなければ読まずに候補を出し、終了コード 1', async () => {
  const { code, out, err } = await cli('rows', 'dev-a', '--days', '2')
  assert.equal(code, 1)
  assert.deepEqual(out, [])
  assert.match(err[0]!, /「dev-a」に当たるセッションが 2 つあります/)
  assert.ok(err.some((l) => l.startsWith('aaaa1111@dev-a')) && err.some((l) => l.startsWith('cccc3333@dev-a')))
  const json = await cli('rows', 'nobody', '--json')
  assert.equal(json.code, 1)
  assert.equal((JSON.parse(json.out[0]!) as { candidates: unknown[] }).candidates.length, 3)
})

test('messages: 返答の行があるか・行は無いが渡してあるか・どちらでもないかを 1 件 1 行で出す', async () => {
  const { code, out } = await cli('messages')
  assert.equal(code, 0)
  assert.match(out[0]!, /^送ったメッセージ 3 件・.*「行なし」は未着とは限らない/)
  assert.deepEqual(out.slice(1).map((l) => l.split(/\s{2,}/)), [
    ['送った', '送り元', '宛先', '本文', '返答'],
    ['10-05 10:00', 'alpha', 'beta', '#1 に着手してください。', '10-05 10:20 PR を出しました。'],
    ['10-05 11:30', 'alpha', 'beta', 'もう 1 つ', '行なし'],
    ['10-05 11:40', 'beta', 'alpha', '補った返答で返ったもの', '行なし（10-05 11:50 に送り元へ渡した）'],
  ])
  const one = await cli('messages', '-n', '2', '--session', 'beta', '--json')
  const body = JSON.parse(one.out[0]!) as { total: number; messages: { message_id: string; state: string; replied_at: string; handed_at: string }[] }
  assert.equal(body.total, 3)
  assert.deepEqual(body.messages.map((m) => [m.message_id, m.state, m.replied_at, m.handed_at]), [
    ['ffff000000000000', 'none', '', ''],
    ['eeee000000000000', 'handed', '', '2026-10-05T02:50:00.000Z'],
  ])
})

test('usage: セッション別・日別に、差で数えた費用を出す。範囲で絞っても積み上げは乗らない', async () => {
  const { code, out } = await cli('usage', '--days', '2')
  assert.equal(code, 0)
  assert.match(out[0]!, /2026-10-04〜2026-10-05・2 セッション・費用は前の行との差/)
  assert.deepEqual(out.slice(1).map((l) => l.split(/\s{2,}/)), [
    ['セッション', 'ターン', '入力', '出力', 'キャッシュ読', 'キャッシュ書', '費用$'],
    ['alpha', '3', '300', '6k', '0', '0', '6.00'],
    ['beta', '1', '100', '2k', '0', '0', '0.50'],
    ['合計（全 2 セッション）', '4', '400', '8k', '0', '0', '6.50'],
  ])
  // 絞ったときは、出した行の小計と範囲の全部の合計を分けて出す（合計が出ている行の和に見えないように）
  const top = await cli('usage', '--days', '2', '-n', '1')
  assert.deepEqual(top.out.slice(2).map((l) => [l.split(/\s{2,}/)[0], l.split(/\s{2,}/).at(-1)]), [
    ['alpha', '6.00'],
    ['小計（上の 1 セッション）', '6.00'],
    ['合計（全 2 セッション）', '6.50'],
  ])
  const topJson = JSON.parse((await cli('usage', '--days', '2', '-n', '1', '--json')).out[0]!) as { sum: { cost_usd: number }; shown_sum: { cost_usd: number } }
  assert.deepEqual([topJson.shown_sum.cost_usd, topJson.sum.cost_usd], [6, 6.5])
  // 10/5 だけに絞る。alpha の 10/5 は 3 → 6 の 2 行で、1 ターンぶんは 2 + 3 = 5（絞ってから差を取ると 3 + 3 = 6 になる）
  const day = await cli('usage', '--by', 'day', '--from', '2026-10-05', '--json')
  const body = JSON.parse(day.out[0]!) as { sum: { cost_usd: number }; rows: { key: string; turns: number; cost_usd: number }[] }
  assert.deepEqual(body.rows.map((r) => [r.key, r.turns, r.cost_usd]), [['2026-10-05', 3, 5.5]])
  assert.equal(body.sum.cost_usd, 5.5)
})

test('使い方の誤りは終了コード 2 で、何も読まない', async () => {
  const wrong = [
    [],
    ['bogus'],
    ['rows'],
    ['rows', 'alpha', '-n', '0'],
    ['usage', '--by', 'week'],
    ['usage', '--from', '10/5'],
    ['usage', '--from', '2026-02-31'],
    ['usage', '--from', '2026-10-06', '--to', '2026-10-05'],
    // そのコマンドで効かないオプション・一緒に効かない組み合わせは、黙って無視せずに断る
    ['usage', '--session', 'alpha'],
    ['usage', '--full'],
    ['rows', 'alpha', '--by', 'day'],
    ['rows', 'alpha', '--session', 'beta'],
    ['messages', '--by', 'day'],
    ['usage', '--from', '2026-10-01', '--days', '3'],
    ['rows', 'alpha', '--all', '-n', '3'],
    ['rows', 'alpha', 'beta'],
    ['messages', 'alpha'],
    // 継いだ名前はコマンドではない・日付に直せない日数は受けない
    ['toString', '--json'],
    ['constructor'],
    ['usage', '--days', '1000000000'],
  ]
  for (const argv of wrong) {
    const { code, out } = await cli(...argv)
    assert.equal(code, 2, argv.join(' '))
    assert.deepEqual(out, [], argv.join(' '))
  }
  assert.equal((await cli('--help')).code, 0)
  assert.match((await cli('usage', '--session', 'alpha')).err[0]!, /usage では効かないオプションです: --session/)
})

test('rows: 入力が人の打った文かどうかを、--json にも --full にも出す', async () => {
  const other = await mkdtemp(join(tmpdir(), 'sai-feed-tool-kind-'))
  try {
    const handed = withHandedReplies('続けて', [{ message_id: MESSAGE_ID, to_name: 'beta', status: 'done', text: '返答です' }])
    await writeFile(
      join(other, '2026-10-05.jsonl'),
      jsonl([
        row('2026-10-05T09:00:00+09:00', 'k', 'r', 'Stop', { user_text: SUMMARY, text: 'a' }),
        row('2026-10-05T09:10:00+09:00', 'k', 'r', 'Stop', { user_text: DAY5[2]!.user_text, text: 'b' }),
        row('2026-10-05T09:20:00+09:00', 'k', 'r', 'Stop', { user_text: handed, text: 'c' }),
        row('2026-10-05T09:30:00+09:00', 'k', 'r', 'Stop', { user_text: '人が打った', text: 'd' }),
      ]),
    )
    const call = async (...argv: string[]) => {
      const out: string[] = []
      await run(argv, { dir: other, now: NOW, out: (l) => out.push(l), err: () => {} })
      return out
    }
    for (const flags of [['--json'], ['--json', '--full']]) {
      const body = JSON.parse((await call('rows', 'k@r', ...flags))[0]!) as { rows: { prompt_kind: string; handed: number; user_text: string }[] }
      assert.deepEqual(body.rows.map((r) => [r.prompt_kind, r.handed]), [['compact', 0], ['message', 0], ['human', 1], ['human', 0]], flags.join(' '))
      // --full の user_text は記録のまま。切った方は頭に足した返答の塊を外す
      assert.equal(body.rows[2]!.user_text, flags.includes('--full') ? handed : '続けて')
    }
    const full = await call('rows', 'k@r', '--full')
    assert.match(full[2]!, /turn {2}\[要約\] This session/)
    assert.match(full[3]!, /turn {2}【SAI】/)
    assert.match(full[4]!, /turn {2}\[返答 1 件\] 続けて +c$/)
    assert.match(full[5]!, /turn {2}人が打った +d$/)
  } finally {
    await rm(other, { recursive: true, force: true })
  }
})

test('リンク越しのパスで起動しても動く（何も出さずに終わらない）', async () => {
  const link = join(dir, '..', `sai-feed-link-${process.pid}`)
  await symlink(fileURLToPath(new URL('../..', import.meta.url)), link)
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', join(link, 'server/tools/feed.ts'), 'usage', '--from', '2026-10-04', '--to', '2026-10-05', '--json'], { env: { ...process.env, AGENT_FEED_DIR: dir } })
    assert.equal((JSON.parse(stdout) as { sum: { cost_usd: number } }).sum.cost_usd, 6.5)
  } finally {
    await rm(link, { force: true })
  }
})

test('読むだけ: どのコマンドを回しても置き場は変わらない', async () => {
  const snapshot = async () => {
    const names = (await readdir(dir)).sort()
    const files = await Promise.all(
      names.map(async (name) => {
        const st = await stat(join(dir, name))
        return [name, st.mtimeMs, st.size, st.isFile() ? await readFile(join(dir, name), 'utf-8') : ''] as const
      }),
    )
    return JSON.stringify(files)
  }
  const beforeRun = await snapshot()
  for (const argv of [['rows', 'alpha'], ['rows', 'alpha', '--all', '--full', '--json'], ['rows', 'nobody'], ['messages'], ['messages', '--all', '--json'], ['usage'], ['usage', '--by', 'day', '--all']]) await cli(...argv)
  assert.equal(await snapshot(), beforeRun)
})
