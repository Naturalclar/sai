import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CACHE_COLD_MS, COLD_COMPACT_TOKENS, COMPACT_HEAD_CHARS, cacheCold, canCompact, COMPACT_MIN_TOKENS, coldAndLarge, compactPrompt, idleLabel, idleMsSince, messageCompacts, replyIdleMs, SEND_MODE_LABEL, SEND_MODE_SHORT, sendCost, sendModes, startsNewWork } from './compact.ts'
import { WAIT_AUTO_WAKE_MS } from './waits.ts'
import { CONTEXT_WARN_TOKENS } from './contextSize.ts'

test('startsNewWork: 実データの着手の形は当たる（#579）', () => {
  for (const t of ['着手して', '526着手して', '#526 着手して', '386に着手して', '482 に着手して', '540対応して', '334対応して', '529を着手して', '着手してください', '579に着手して。', '着手して\n補足: まず調べて']) {
    assert.equal(startsNewWork(t), true, t)
  }
})

test('startsNewWork: 狭く倒す。続きの指示・人への依頼・着手と関係ない文は当たらない（#579）', () => {
  for (const t of ['修正も着手して', 'セッション C のセッションで564着手', 'マージして', '対応して', 'レビューに対応して', '着手する前に調べて', 'issue 追加。着手して', '', '  ']) {
    assert.equal(startsNewWork(t), false, t)
  }
})

const big = COMPACT_MIN_TOKENS + 1
const claude = { agent: 'claude', terminal: false }

test('sendModes: 着手 × Claude × 下限以上なら要約してから送るが既定（#579）', () => {
  assert.deepEqual(sendModes({ ...claude, text: '579着手して', contextTokens: big }, CONTEXT_WARN_TOKENS), { mode: 'compact', choices: ['compact', 'plain', 'new'] })
})

test('sendModes: 小さい・量が分からない・端末で開いている・Claude でないときは要約しない（#579）', () => {
  assert.deepEqual(sendModes({ ...claude, text: '579着手して', contextTokens: COMPACT_MIN_TOKENS - 1 }, CONTEXT_WARN_TOKENS), { mode: 'plain', choices: ['plain', 'new'] }, '新しいセッションは選べる')
  assert.deepEqual(sendModes({ ...claude, text: '579着手して', contextTokens: 0 }, CONTEXT_WARN_TOKENS).mode, 'plain')
  assert.deepEqual(sendModes({ ...claude, terminal: true, text: '579着手して', contextTokens: big }, CONTEXT_WARN_TOKENS).mode, 'plain')
  assert.deepEqual(sendModes({ agent: 'codex', terminal: false, text: '579着手して', contextTokens: big }, CONTEXT_WARN_TOKENS), { mode: 'plain', choices: [] }, 'Codex は対象外')
})

test('sendModes: 着手でなければそのまま。警告を超えていれば要約を横に出す（#579）', () => {
  assert.deepEqual(sendModes({ ...claude, text: 'マージして', contextTokens: big }, CONTEXT_WARN_TOKENS), { mode: 'plain', choices: [] }, '何も出さない')
  assert.deepEqual(sendModes({ ...claude, text: 'マージして', contextTokens: CONTEXT_WARN_TOKENS }, CONTEXT_WARN_TOKENS), { mode: 'plain', choices: ['compact', 'plain', 'new'] })
})

test('canCompact', () => {
  assert.equal(canCompact({ agent: 'claude', terminal: false, contextTokens: COMPACT_MIN_TOKENS }), true)
  assert.equal(canCompact({ agent: 'claude', terminal: true, contextTokens: COMPACT_MIN_TOKENS }), false)
})

test('compactPrompt: 着手の形なら、/compact に次に取りかかることを添える（1 行目だけ）。指示の形は今までどおり', () => {
  const p = compactPrompt('579着手して\n詳しくは本文')
  assert.equal(p, '/compact 次は「579着手して」に取りかかる。終わった作業の細部（差分・ログ・やりとり）は捨て、リポジトリの決まり・ユーザーの好み・まだ終わっていない約束だけを残す')
  assert.doesNotMatch(p, /詳しくは本文/)
})

test('compactPrompt: 着手の形でない本文には、直近の作業の中身を残させる指示にする（聞かれる前に答えの材料を捨てさせない。#761）', () => {
  const p = compactPrompt('お疲れさまです。\nさっきの変更で launch() の引数をどう変えたか教えてください')
  assert.match(p, /^\/compact このあと「お疲れさまです。 さっきの変更で launch\(\) の引数をどう変えたか教えてください」というメッセージが届く/, '1 行目だけでなく本文の頭を渡す（改行は畳む）')
  assert.match(p, /直近の作業で変えた箇所・決めたこと・分かったこと）と、リポジトリの決まり・ユーザーの好み・まだ終わっていない約束は残す/)
  assert.doesNotMatch(p, /に取りかかる/, '着手の指示（前の作業の細部は捨てる）は当てない')
  assert.ok(compactPrompt('あ'.repeat(1000)).length < COMPACT_HEAD_CHARS + 200, '長い本文は頭だけ')
  // 境目に絵文字が来ても、片割れを残さない
  assert.match(compactPrompt(`${'x'.repeat(COMPACT_HEAD_CHARS - 1)}😀続き`), /x😀」というメッセージが届く/)
  // 待ちで起こす本文（#732）も着手の形ではない
  assert.match(compactPrompt('【SAI 待ち】PR #12（o/r）: CI は全部通りました\n\n預けたときに書いたこと: 結果を読んで報告する'), /^\/compact このあと「【SAI 待ち】PR #12（o\/r）: CI は全部通りました 預けたときに書いたこと/)
})

test('SEND_MODE_SHORT: どの送り方にも短い表記があり、正式な名前より短い（#629）', () => {
  for (const mode of ['compact', 'plain', 'new'] as const) {
    assert.ok(SEND_MODE_SHORT[mode].length > 0)
    assert.ok(SEND_MODE_SHORT[mode].length < SEND_MODE_LABEL[mode].length, mode)
  }
})

test('messageCompacts: メッセージは画面と同じ判定。指定があれば指定が勝つが、要約できない相手は要約しない（#624）', () => {
  const big = { agent: 'claude', contextTokens: 500_000, terminal: false }
  assert.equal(messageCompacts({ ...big, text: '#624 に着手してください。\n説明は 2 行目から' }, CONTEXT_WARN_TOKENS), true)
  assert.equal(messageCompacts({ ...big, text: '#624 に着手してください（説明）。正本は issue です。' }, CONTEXT_WARN_TOKENS), false, '1 行目に続きを書くと当たらない')
  assert.equal(messageCompacts({ ...big, text: 'ここはどう変えましたか？' }, CONTEXT_WARN_TOKENS), false, '警告を超えていても、着手でなければ要約しない')
  assert.equal(messageCompacts({ ...big, text: 'ここはどう変えましたか？' }, CONTEXT_WARN_TOKENS, true), true)
  assert.equal(messageCompacts({ ...big, text: '#624 に着手してください。' }, CONTEXT_WARN_TOKENS, false), false)
  for (const cannot of [{ ...big, terminal: true }, { ...big, agent: 'codex' }, { ...big, contextTokens: COMPACT_MIN_TOKENS - 1 }, { ...big, contextTokens: 0 }]) {
    assert.equal(messageCompacts({ ...cannot, text: '#624 に着手してください。' }, CONTEXT_WARN_TOKENS), false)
    assert.equal(messageCompacts({ ...cannot, text: '#624 に着手してください。' }, CONTEXT_WARN_TOKENS, true), false)
  }
})

test('分岐して送る（#405）: Codex で分岐できるときだけ、そのままの横に出す。既定にはしない', () => {
  const codex = { agent: 'codex', contextTokens: 0, terminal: false, text: '別の方針で' }
  assert.deepEqual(sendModes({ ...codex, forkable: true }, CONTEXT_WARN_TOKENS), { mode: 'plain', choices: ['plain', 'fork'] })
  assert.deepEqual(sendModes(codex, CONTEXT_WARN_TOKENS), { mode: 'plain', choices: [] }, '分岐できなければ今までどおり何も出さない')
  assert.deepEqual(sendModes({ ...codex, forkable: true, terminal: true }, CONTEXT_WARN_TOKENS).choices, [], '端末で開いているものには出さない')
  assert.deepEqual(sendModes({ ...codex, agent: 'claude', forkable: true }, CONTEXT_WARN_TOKENS).choices, [], 'Claude には出さない')
  // OpenCode も同じ口（#398）
  assert.deepEqual(sendModes({ ...codex, agent: 'opencode', forkable: true }, CONTEXT_WARN_TOKENS), { mode: 'plain', choices: ['plain', 'fork'] })
  assert.deepEqual(sendModes({ ...codex, agent: 'opencode' }, CONTEXT_WARN_TOKENS).choices, [])
  assert.deepEqual(sendModes({ ...codex, agent: 'opencode', forkable: true, terminal: true }, CONTEXT_WARN_TOKENS).choices, [])
  assert.equal(SEND_MODE_LABEL.fork, '分岐して送る')
})

// ---- 間があいて大きいセッション（#761）

const COLD = CACHE_COLD_MS + 60_000

test('境目は 1 つ: 待ち（#732）の「自動では起こさない」線と、キャッシュが切れている見込みの線は同じ値（#761）', () => {
  assert.equal(WAIT_AUTO_WAKE_MS, CACHE_COLD_MS)
  assert.equal(COLD_COMPACT_TOKENS, CONTEXT_WARN_TOKENS, '仮の閾値は見出しの警告と同じ区切り')
})

test('idleMsSince / cacheCold: 間が分からなければ切れていない側。境目ちょうどは切れていない（#761）', () => {
  const now = Date.parse('2026-01-01T10:00:00+09:00')
  assert.equal(idleMsSince('2026-01-01T09:00:00+09:00', now), 60 * 60_000)
  assert.equal(idleMsSince('2026-01-01T10:00:05+09:00', now), 0, '先の時刻は 0')
  assert.equal(idleMsSince('', now), undefined)
  assert.equal(idleMsSince(undefined, now), undefined)
  assert.equal(idleMsSince('読めない', now), undefined)
  assert.equal(cacheCold(undefined), false)
  assert.equal(cacheCold(CACHE_COLD_MS), false)
  assert.equal(cacheCold(CACHE_COLD_MS + 1), true)
})

test('sendModes: 間があいて大きい Claude のセッションは、着手の形でなくても要約が既定。人は「そのまま」を選べる（#761）', () => {
  const cold = { ...claude, text: 'マージして', contextTokens: COLD_COMPACT_TOKENS, idleMs: COLD }
  assert.deepEqual(sendModes(cold, CONTEXT_WARN_TOKENS), { mode: 'compact', choices: ['compact', 'plain', 'new'] })
  assert.equal(sendModes({ ...cold, idleMs: CACHE_COLD_MS }, CONTEXT_WARN_TOKENS).mode, 'plain', '温かければそのまま（選べるのは今までどおり）')
  assert.equal(sendModes({ ...cold, contextTokens: COLD_COMPACT_TOKENS - 1 }, CONTEXT_WARN_TOKENS).mode, 'plain', '小さければそのまま')
  const { idleMs: _idle, ...unknown } = cold
  assert.equal(sendModes(unknown, CONTEXT_WARN_TOKENS).mode, 'plain', '間が分からなければそのまま')
  assert.equal(coldAndLarge(cold), true)
})

test('sendModes: 間があいて大きくても、要約できない相手（端末で開いている・Claude 以外）には何もしない（#761）', () => {
  assert.equal(sendModes({ ...claude, terminal: true, text: 'マージして', contextTokens: 800_000, idleMs: COLD }, CONTEXT_WARN_TOKENS).mode, 'plain')
  assert.deepEqual(sendModes({ agent: 'codex', terminal: false, text: 'マージして', contextTokens: 800_000, idleMs: COLD }, CONTEXT_WARN_TOKENS), { mode: 'plain', choices: [] })
  assert.deepEqual(sendModes({ agent: 'opencode', terminal: false, text: 'マージして', contextTokens: 800_000, idleMs: COLD }, CONTEXT_WARN_TOKENS), { mode: 'plain', choices: [] })
})

test('messageCompacts: 着手の形でなくても、間があいて大きい相手には要約を挟む。compact: false で外せる（#761）', () => {
  const cold = { agent: 'claude', terminal: false, contextTokens: 800_000, idleMs: COLD, text: 'PR をレビューしてマージしてください' }
  assert.equal(messageCompacts(cold, CONTEXT_WARN_TOKENS), true)
  assert.equal(messageCompacts(cold, CONTEXT_WARN_TOKENS, false), false)
  assert.equal(messageCompacts({ ...cold, idleMs: 5 * 60_000 }, CONTEXT_WARN_TOKENS), false, '温かい相手はそのまま')
  assert.equal(messageCompacts({ ...cold, terminal: true }, CONTEXT_WARN_TOKENS), false)
  assert.equal(messageCompacts({ ...cold, agent: 'codex' }, CONTEXT_WARN_TOKENS, true), false)
})

test('replyIdleMs: 入力欄の間は、時計が無い・処理中か預かりがあるときは分からない扱い（送り方の既定も変えない。#761）', () => {
  const now = Date.parse('2026-01-01T12:00:00+09:00')
  const lastTurnAt = '2026-01-01T10:00:00+09:00'
  assert.equal(replyIdleMs({ lastTurnAt, now, queueing: false }), 2 * 60 * 60_000)
  assert.equal(replyIdleMs({ lastTurnAt, now: 0, queueing: false }), undefined, '時計を渡していない')
  assert.equal(replyIdleMs({ lastTurnAt, now, queueing: true }), undefined, '処理中・預かりがある')
  assert.equal(replyIdleMs({ lastTurnAt: undefined, now, queueing: false }), undefined)
})

test('idleLabel / sendCost: 入力欄に出す 1 行。キャッシュの印は Claude だけ、どちらも分からなければ出さない（#761）', () => {
  assert.equal(idleLabel(0), '0 分')
  assert.equal(idleLabel(59 * 60_000), '59 分')
  assert.equal(idleLabel(72 * 60_000), '1 時間 12 分')
  assert.equal(idleLabel(120 * 60_000), '2 時間')
  assert.equal(idleLabel(49 * 60 * 60_000), '2 日')
  assert.equal(idleLabel(undefined), '')
  assert.equal(sendCost({ agent: 'claude', context: '', idleMs: undefined }), null)
  const warm = sendCost({ agent: 'claude', context: '810k', idleMs: 12 * 60_000 })
  assert.equal(warm?.text, 'いま 810k ・ 最後のターンから 12 分')
  assert.equal(warm?.cold, false)
  const cold = sendCost({ agent: 'claude', context: '810k', idleMs: COLD })
  assert.equal(cold?.cold, true)
  assert.match(cold?.title ?? '', /キャッシュが切れている見込み/)
  assert.equal(sendCost({ agent: 'codex', context: '', idleMs: COLD })?.cold, false, 'Claude 以外には印を付けない')
  assert.equal(sendCost({ agent: 'claude', context: '', idleMs: COLD })?.text, `最後のターンから ${idleLabel(COLD)}`)
})
