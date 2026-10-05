// 一言の案を比べる道具の採点（#712）: 事例ごとの「守ること」を 1 つずつ・事例のファイルの形・コミットしてはいけない形の歯止め
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { CASES_PATH } from './cli.ts'
import { caseLeaks, CASE_NUMBER_MIN, expectIssues, scoreSummary, SCORE_LABELS, SHAPES, validateCases } from './score.ts'
import type { EvalCase } from './score.ts'

const NUM = CASE_NUMBER_MIN + 1
const OTHER = CASE_NUMBER_MIN + 2

// ---- 守ること 1 つずつ: 通る例と落ちる例

test('keep: 書いた文字が全部残っていれば通る・1 つでも無ければ落ちる', () => {
  assert.deepEqual(expectIssues({ keep: ['マージして'] }, '直したよ。「マージして」と言ってください'), [])
  assert.deepEqual(expectIssues({ keep: ['マージして'] }, '直したよ。入れてよいか教えて'), ['expect:keep'])
  assert.deepEqual(expectIssues({ keep: ['直して', '続けて'] }, '「直して」と言ってください'), ['expect:keep'])
})

test('numbers: 出るはずの番号が無ければ落ちる。別の番号の一部は数えない', () => {
  assert.deepEqual(expectIssues({ numbers: [String(NUM)] }, `PR #${NUM} を出したよ`), [])
  assert.deepEqual(expectIssues({ numbers: [String(NUM)] }, 'PR を出したよ'), ['expect:number_missing'])
  // `90011` の中の `9001` は別の番号
  assert.deepEqual(expectIssues({ numbers: [String(NUM)] }, `PR #${NUM}1 を出したよ`), ['expect:number_missing'])
})

test('no_numbers: 出してはいけない番号が出たら落ちる', () => {
  assert.deepEqual(expectIssues({ no_numbers: [String(OTHER)] }, `PR #${NUM} を出したよ`), [])
  assert.deepEqual(expectIssues({ no_numbers: [String(OTHER)] }, `PR #${OTHER} を出したよ`), ['expect:number_extra'])
})

test('action: 並べた語のどれかが出れば通る・どれも無ければ落ちる', () => {
  assert.deepEqual(expectIssues({ action: ['作成', '作り'] }, 'PR を作りました'), [])
  assert.deepEqual(expectIssues({ action: ['作成', '作り'] }, 'PR をマージしました'), ['expect:action_missing'])
})

test('no_action: 出てはいけない動作の語が出たら落ちる', () => {
  assert.deepEqual(expectIssues({ no_action: ['マージしました'] }, 'PR を出したよ。「マージして」と言ってください'), [])
  assert.deepEqual(expectIssues({ no_action: ['マージしました'] }, 'PR をマージしました'), ['expect:action_wrong'])
})

test('request keep: 人が次にすることが残っていれば通る・報告だけなら落ちる', () => {
  assert.deepEqual(expectIssues({ request: 'keep' }, '直したよ。「マージして」と言ってください'), [])
  assert.deepEqual(expectIssues({ request: 'keep' }, '直したよ。CI は緑'), ['expect:request_dropped'])
})

test('request none: 報告だけなら通る・頼みや問いかけを作ったら落ちる', () => {
  assert.deepEqual(expectIssues({ request: 'none' }, '絞り込みを足したよ。テストも通った'), [])
  assert.deepEqual(expectIssues({ request: 'none' }, '絞り込みを足したよ。見てみて'), ['expect:request_invented'])
  assert.deepEqual(expectIssues({ request: 'none' }, '絞り込みを足したよ。これでいい？'), ['expect:request_invented'])
})

test('書いていない項目は見ない', () => {
  assert.deepEqual(expectIssues({}, 'なんでも？'), [])
})

// ---- 一言 1 つの採点

const sample: EvalCase = {
  id: 'x-01',
  shape: 'merge_wait',
  ask: '',
  text: `PR #${NUM} を出しました。よければ「マージして」と言ってください。`,
  expect: { keep: ['マージして'], numbers: [String(NUM)], request: 'keep' },
}

test('scoreSummary: digestIssues() の項目と、事例の項目を続けて返す', () => {
  assert.deepEqual(scoreSummary(sample, `PR #${NUM} を出したよ。「マージして」と言ってください`), [])
  // 本文に無い番号（digestIssues）と、出るはずの番号が無い（事例）の両方
  const codes = scoreSummary(sample, `PR #${OTHER} を出したよ。「マージして」と言ってください`)
  assert.ok(codes.includes('invented_number'))
  assert.ok(codes.includes('expect:number_missing'))
  // 頼みを落とすと、両方の側から数える（集計では 1 つの組にまとめる）
  const dropped = scoreSummary(sample, `PR #${NUM} を出したよ`)
  assert.ok(dropped.includes('dropped_request'))
  assert.ok(dropped.includes('expect:request_dropped'))
  assert.ok(dropped.includes('expect:keep'))
})

test('scoreSummary: 空の一言は empty だけ・守ることの無い事例は digestIssues() だけ', () => {
  assert.deepEqual(scoreSummary(sample, '  '), ['empty'])
  assert.deepEqual(scoreSummary({ ...sample, shape: 'feed', expect: undefined }, `PR #${NUM} を出したよ。見てみて`), [])
})

test('項目の名前は全部に付いている', () => {
  for (const [code, label] of Object.entries(SCORE_LABELS)) assert.ok(label, code)
})

// ---- コミットしてはいけない形の歯止め（文字は作り物）

test('caseLeaks: ホームのパス・メールの形・セッション ID・アカウント名の URL・worktree 名・小さい番号を見つける', () => {
  const hit = (text: string, label: string) => assert.ok(caseLeaks(text).some((l) => l.startsWith(label)), `${label}: ${text}`)
  hit('置き場は /Users/someone/work です', 'ホームのパス')
  hit('置き場は /home/someone/work です', 'ホームのパス')
  hit('someone@example.com に送りました', 'メールアドレスの形')
  hit('セッション 00000000-0000-4000-8000-000000000000 です', 'セッション ID（UUID）')
  hit('セッション ses_0123456789abcdef です', 'セッション ID（ses_）')
  hit('https://github.com/someone/project/pull/9001', 'アカウント名の URL')
  hit('dev-something の worktree で直しました', 'worktree 名')
  hit('PR #12 を出しました', '実在しうる番号')
})

test('caseLeaks: 作り物の形（dev-worktree-a・大きい番号）は通す', () => {
  assert.deepEqual(caseLeaks(`dev-worktree-a で PR #${NUM} を出しました。\`low_stock\` を読みます`), [])
})

// ---- 事例のファイルの形

const good = () => ({ id: 'a-01', shape: 'done', ask: '', text: `PR #${NUM} を作成しました。`, expect: { numbers: [String(NUM)], action: ['作成', '作り'], request: 'none' } })

test('validateCases: 正しい形は通る', () => {
  assert.deepEqual(validateCases([good()]), [])
})

test('validateCases: 形の誤りを 1 つずつ言う', () => {
  const errs = (patch: Record<string, unknown>) => validateCases([{ ...good(), ...patch }]).join('\n')
  assert.match(validateCases({}).join('\n'), /配列/)
  assert.match(errs({ id: 'A 01' }), /id は/)
  assert.match(validateCases([good(), good()]).join('\n'), /id が重なっている/)
  assert.match(errs({ shape: 'feed' }), /shape は/)
  assert.match(errs({ text: ' ' }), /text が空/)
  assert.match(errs({ expect: undefined }), /expect（守ること）が無い/)
  assert.match(errs({ expect: {} }), /expect が空/)
  assert.match(errs({ expect: { nubmers: ['1'] } }), /知らない項目/)
  assert.match(errs({ expect: { keep: [] } }), /空でない文字の配列/)
  assert.match(errs({ expect: { request: 'maybe' } }), /keep か none/)
})

test('validateCases: 守ることが本文と食い違っていたら言う（事例の書き損じを採点の結果と取り違えない）', () => {
  const errs = (expect: Record<string, unknown>) => validateCases([{ ...good(), expect }]).join('\n')
  assert.match(errs({ numbers: [String(OTHER)] }), /本文にも頼んだことにも無い/)
  assert.match(errs({ keep: ['マージして'] }), /keep の「マージして」が本文に無い/)
  assert.match(errs({ action: ['マージ'] }), /action のどれも本文に無い/)
  assert.match(errs({ numbers: [String(NUM)], no_numbers: [String(NUM)] }), /両方にある/)
  // 頼んだことにある番号は「出る」と書いてよい
  assert.deepEqual(validateCases([{ ...good(), ask: `#${OTHER} に着手して`, expect: { no_numbers: [String(OTHER)] } }]), [])
})

test('validateCases: コミットしてはいけない形が入っていたら落とす', () => {
  assert.match(validateCases([{ ...good(), text: `PR #${NUM} を作成しました。/Users/someone/work に置きました` }]).join('\n'), /ホームのパス/)
  assert.match(validateCases([{ ...good(), ask: 'PR #12 を見て' }]).join('\n'), /実在しうる番号/)
})

// ---- コミットしている事例そのもの（CI で回る）

test('cases.json: 形が正しく、名前の類が入っていない', async () => {
  const raw: unknown = JSON.parse(await readFile(CASES_PATH, 'utf-8'))
  assert.deepEqual(validateCases(raw), [])
})

test('cases.json: 30 件ほどあり、どの形も 3 件以上ある（偏らない）', async () => {
  const cases = JSON.parse(await readFile(CASES_PATH, 'utf-8')) as EvalCase[]
  assert.ok(cases.length >= 30, `${cases.length} 件`)
  for (const shape of SHAPES) assert.ok(cases.filter((c) => c.shape === shape).length >= 3, shape)
})
