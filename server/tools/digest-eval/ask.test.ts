// 「次に送る文面の案」の比べ（#729。`pnpm digest:eval --ask`）。偽の口で回す。本物の口・本物の置き場は触らない
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextAskPrompt } from '../../../shared/nextAsk.ts'
import type { Summarizer, SummarizerFactory } from '../../digest/digest.ts'
import { ASK_SHAPES, ASK_VARIANTS, askReport, askTotals, formNextAskPrompt, pickAskVariants, runAsk, validateAskCases } from './ask.ts'
import type { AskCase, AskSample } from './ask.ts'
import { ASK_CASES_PATH, run } from './cli.ts'
import type { Io } from './cli.ts'

// ---- 事例のファイル（CI で回る）

test('ask-cases.json: 形が正しく、名前の類・引用の頼みが入っていない', async () => {
  assert.deepEqual(validateAskCases(JSON.parse(await readFile(ASK_CASES_PATH, 'utf-8'))), [])
})

test('ask-cases.json: どの形も 4 件以上ある（偏らない）', async () => {
  const cases = JSON.parse(await readFile(ASK_CASES_PATH, 'utf-8')) as AskCase[]
  for (const shape of ASK_SHAPES) assert.ok(cases.filter((c) => c.shape === shape).length >= 4, shape)
})

test('validateAskCases: 形の誤り・引用の頼み・コミットしてはいけない形を言う', () => {
  const good = { id: 'a-01', shape: 'report', ask: '', text: '書き直しました。' }
  const errs = (patch: Record<string, unknown>) => validateAskCases([{ ...good, ...patch }]).join('\n')
  assert.deepEqual(validateAskCases([good]), [])
  assert.match(validateAskCases({}).join('\n'), /配列/)
  assert.match(errs({ id: 'A 01' }), /id は/)
  assert.match(validateAskCases([good, good]).join('\n'), /id が重なっている/)
  assert.match(errs({ shape: 'feed' }), /shape は/)
  assert.match(errs({ text: ' ' }), /text が空/)
  assert.match(errs({ text: 'よければ「進めて」と言ってください。' }), /引用の頼み/)
  assert.match(errs({ text: '/Users/someone/work に置きました。' }), /ホームのパス/)
  assert.match(errs({ ask: 'PR #12 を見て' }), /実在しうる番号/)
})

// ---- 案の一覧

test('形で縛ったプロンプトは比べる相手として残す（本番には入れていない）。形の例は型だけで、中身の語を置かない', () => {
  const head = formNextAskPrompt('入力', '返答').split('\n---\n')[0]!
  assert.match(head, /エージェントへの指示（「〜して」の形）か、エージェントの問いへの答え/)
  assert.doesNotMatch(nextAskPrompt('入力', '返答'), /エージェントの問いへの答え/)
  // どちらも同じ印（偽の口が案のプロンプトを見分ける文）を持つ
  for (const p of [formNextAskPrompt('入力', '返答'), nextAskPrompt('入力', '返答')]) assert.match(p, /あなたが次に送る文/)
  assert.doesNotMatch(head, /#\d/)
  // 「」の中は型（〜 で始まる）だけ
  for (const m of head.matchAll(/「([^」]+)」/g)) assert.match(m[1]!, /^(?:〜|案:$)/, `作例「${m[1]}」に中身がある（書き写される）`)
  // 作り直しの材料も同じ形で足す
  assert.match(formNextAskPrompt('入力', '返答', { retry: { nextAsk: '前の案', issues: [{ code: 'copy', hint: '直す点' }] } }), /前に作った文: 前の案[\s\S]*- 直す点/)
})

test('pickAskVariants: 知らない案・重なりは断る', () => {
  assert.deepEqual((pickAskVariants('nocheck,check') as { id: string }[]).map((v) => v.id), ['nocheck', 'check'])
  assert.match(String(pickAskVariants('current')), /知らない案: current/)
  assert.match(String(pickAskVariants('check,check')), /2 回/)
})

// ---- 回し方と集計

const CASES: AskCase[] = [
  { id: 'q', shape: 'question', ask: '', text: 'この変更で出しますか？' },
  { id: 'r', shape: 'report', ask: '', text: '書き直しました。' },
]

/** いつも本文の最後の文を写す口（小さいモデルの崩れ方） */
const echo = async (prompt: string) => (prompt.split('エージェントの返答:\n')[1] ?? '').trim()

test('runAsk: 確かめなしは写しをそのまま出し、確かめありは作り直しても駄目なら出さない', async () => {
  const variants = ASK_VARIANTS.filter((v) => v.id === 'nocheck' || v.id === 'check')
  const samples = await runAsk({ cases: CASES, variants, runs: 1, summarize: echo })
  assert.deepEqual(samples.map((s) => [s.case, s.variant, s.next_ask, s.codes]), [
    ['q', 'nocheck', 'この変更で出しますか？', ['question_back']],
    ['q', 'check', '', []],
    ['r', 'nocheck', '書き直しました。', ['declaration']],
    ['r', 'check', '', []],
  ])
})

test('runAsk: 口が落ちた回は error として残し、止めない', async () => {
  let n = 0
  const samples = await runAsk({ cases: CASES, variants: [ASK_VARIANTS[0]!], runs: 1, summarize: async () => (++n === 1 ? Promise.reject(new Error('timeout')) : '直して') })
  assert.deepEqual(samples.map((s) => s.error ?? s.next_ask), ['timeout', '直して'])
})

const s = (id: string, variant: string, nextAsk: string, codes: AskSample['codes'] = [], shape = 'report'): AskSample => ({ case: id, shape, variant, run: 1, next_ask: nextAsk, codes })

test('askTotals: 読める・出さなかった・理由ごとの数', () => {
  const t = askTotals('a', [s('1', 'a', '直して'), s('2', 'a', ''), s('3', 'a', '直します', ['declaration']), { ...s('4', 'a', ''), error: 'x' }, s('1', 'b', '直して')])
  assert.deepEqual(t, { variant: 'a', samples: 3, errors: 1, readable: 1, none: 1, codes: { declaration: 1 } })
})

test('askReport: 2 つの割合と、形ごとの「読める」を出す。案の中身は出さない', () => {
  const samples = [s('1', 'a', '案の中身その一', ['declaration']), s('1', 'b', '案の中身その二'), s('2', 'a', '案の中身その三', [], 'question'), s('2', 'b', '', [], 'question')]
  const text = askReport(samples, ['a', 'b'], ['作り物 2 件']).join('\n')
  assert.match(text, /\*\*人の返信として読める\*\* \| 1（50%） \| 1（50%）/)
  assert.match(text, /\*\*案を出さなかった\*\* \| 0（0%） \| 1（50%）/)
  assert.match(text, /エージェントの宣言の形（〜します） `declaration` \| 1（50%） \| 0（0%）/)
  assert.match(text, /問いで終わる \| 1（100%） \| 0（0%）/)
  assert.match(text, /- 作り物 2 件/)
  assert.doesNotMatch(text, /案の中身/)
})

// ---- コマンド

let dir: string
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-ask-eval-test-'))
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ digest: true, digest_provider: 'openai', digest_model: 'fake-model' }))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

function io(prompts: string[] = []): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  const factory: SummarizerFactory = (): Summarizer => ({ summarize: async (prompt) => (prompts.push(prompt), '次に進めて') })
  return { dir, now: new Date('2026-03-04T03:00:00Z'), env: {}, out: (l) => stdout.push(l), err: (l) => stderr.push(l), factory, stdout, stderr }
}

test('run --ask: 作り物の事例で案を比べる。数字だけを出し、案の中身は置き場の外のファイルにだけ残す', async () => {
  const out = join(dir, 'out-ask')
  const prompts: string[] = []
  const x = io(prompts)
  assert.equal(await run(['--ask', '--variants', 'nocheck,check', '--out', out], x), 0)
  const text = x.stdout.join('\n')
  assert.match(text, /次に送る文面の案の比べ/)
  assert.match(text, /\*\*人の返信として読める\*\* \| 20（100%） \| 20（100%）/)
  assert.doesNotMatch(text + x.stderr.join('\n'), /次に進めて/)
  assert.ok(prompts.every((p) => p.includes('あなたが次に送る文')), '案のプロンプトだけを口に渡す（一言は作らない）')
  assert.ok(prompts.every((p) => !p.includes('口調')), '案に性格を足さない')
  const samples = (await readFile(join(out, 'outputs.jsonl'), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l) as AskSample)
  assert.equal(samples.length, 40)
  assert.ok(samples.every((v) => v.next_ask === '次に進めて'))
})

test('run --ask: 一言の案の名前・効かないオプションは使い方の誤り', async () => {
  for (const argv of [['--ask', '--variants', 'current'], ['--ask', '--include-asking'], ['--ask', '--persona', 'ENFP']]) {
    assert.equal(await run(argv, io()), 2, argv.join(' '))
  }
})
