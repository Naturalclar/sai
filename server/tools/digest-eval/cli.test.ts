// 一言の案を比べる道具を、偽の口で通しで回す（#712）。本物の口・本物の置き場は触らない
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localDate } from '../../../shared/entity.ts'
import type { Summarizer, SummarizerFactory } from '../../digest/digest.ts'
import { feedCases, insideRepo, REPO_ROOT, run, runEval } from './cli.ts'
import type { Io } from './cli.ts'
import type { Sample } from './report.ts'
import type { EvalCase } from './score.ts'
import { pickVariants, VARIANTS } from './variants.ts'

let dir: string
const NOW = new Date('2026-03-04T03:00:00Z')

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-digest-eval-test-'))
  // 口は手元（openai）・モデルあり、の設定
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ digest: true, digest_provider: 'openai', digest_model: 'fake-model', persona: 'none' }))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 今のプロンプトには無難な一言、規則なしの案には本文に無い番号を返す口。呼ばれたプロンプトを覚える */
function fakeFactory(prompts: string[] = []): SummarizerFactory {
  return (): Summarizer => ({
    summarize: async (prompt) => {
      prompts.push(prompt)
      return prompt.includes('話の筋を残す') ? '作業が終わったよ' : 'PR #1 を出したよ'
    },
  })
}

function io(over: Partial<Io> = {}): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return { dir, now: NOW, env: {}, out: (l) => stdout.push(l), err: (l) => stderr.push(l), factory: fakeFactory(), stdout, stderr, ...over }
}

const outputs = async (out: string) => (await readFile(join(out, 'outputs.jsonl'), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l) as Sample)

test('runEval: 事例 × 回 × 案を回し、同じ事例・同じ回を案で続ける。人に聞いている返答は回さない', async () => {
  const cases: EvalCase[] = [
    { id: 'a', shape: 'done', ask: '', text: '絞り込みを足しました。', expect: { request: 'none' } },
    { id: 'q', shape: 'question', ask: '', text: 'どちらにしますか？', expect: { request: 'keep' } },
  ]
  const variants = pickVariants('current,bare')
  assert.ok(Array.isArray(variants))
  const r = await runEval({ cases, variants, runs: 2, persona: 'none', summarizer: fakeFactory()('openai', 'm') })
  assert.deepEqual(r.skipped, ['q'])
  assert.deepEqual(r.samples.map((s) => `${s.case}${s.run}${s.variant}`), ['a1current', 'a1bare', 'a2current', 'a2bare'])
  assert.deepEqual(r.samples[0]!.codes, [])
  assert.ok(r.samples[1]!.codes.includes('invented_number'))
  const all = await runEval({ cases, variants, runs: 1, persona: 'none', summarizer: fakeFactory()('openai', 'm'), includeAsking: true })
  assert.deepEqual(all.skipped, [])
  assert.equal(all.samples.length, 4)
})

test('runEval: 口が落ちた回は error として残し、止めない', async () => {
  let n = 0
  const summarizer: Summarizer = {
    summarize: async () => {
      if (++n === 1) throw new Error('timeout after 90s')
      return '終わったよ'
    },
  }
  const cases: EvalCase[] = [{ id: 'a', shape: 'done', ask: '', text: '足しました。' }, { id: 'b', shape: 'done', ask: '', text: '消しました。' }]
  const r = await runEval({ cases, variants: [VARIANTS[0]!], runs: 1, persona: 'none', summarizer })
  assert.deepEqual(r.samples.map((s) => s.error ?? 'ok'), ['timeout after 90s', 'ok'])
})

test('今のプロンプトの案は digestPrompt() をそのまま渡す（頼んだことも）', async () => {
  const prompts: string[] = []
  await VARIANTS[0]!.make({ persona: 'none', text: '足しました。', ask: '足して' }, async (p) => (prompts.push(p), 'x'))
  assert.match(prompts[0]!, /人が頼んだこと:\n足して/)
  assert.match(prompts[0]!, /話の筋を残す/)
})

test('pickVariants: 知らない案・重なりは断る', () => {
  assert.match(String(pickVariants('current,nope')), /知らない案: nope/)
  assert.match(String(pickVariants('current,current')), /2 回/)
  assert.match(String(pickVariants(' , ')), /1 つは/)
})

test('run: 作り物の事例で 2 つの案を比べる。数字だけを出し、一言は置き場の外のファイルにだけ残す', async () => {
  const out = join(dir, 'out-compare')
  const x = io()
  const code = await run(['--variants', 'current,bare', '--runs', '2', '--out', out], x)
  // 規則なしの案は本文に無い番号を書くので、通す条件を満たさない
  assert.equal(code, 1)
  const text = x.stdout.join('\n')
  assert.match(text, /通す条件: 満たしていない.*本文に無い番号/)
  assert.match(text, /▲ 本文に無い番号/)
  assert.match(text, /口: openai \/ fake-model・性格 none・2 回ずつ/)
  assert.match(text, /人に聞いている返答なので回さなかった/)
  // 一言の中身は標準出力にも標準エラーにも出ない
  assert.doesNotMatch(text + x.stderr.join('\n'), /作業が終わったよ|出したよ/)
  const samples = await outputs(out)
  assert.ok(samples.some((s) => s.summary === '作業が終わったよ'))
  assert.equal(samples.filter((s) => s.variant === 'current').length, samples.filter((s) => s.variant === 'bare').length)
  assert.equal((await readFile(join(out, 'report.md'), 'utf-8')).trim(), text)
})

test('run: 案が 1 つなら件数だけ出して 0 で終わる', async () => {
  const x = io()
  assert.equal(await run(['--out', join(dir, 'out-one')], x), 0)
  assert.match(x.stdout.join('\n'), /\| 一言が取れた \| \d+ \|/)
  assert.doesNotMatch(x.stdout.join('\n'), /###/)
})

test('run: 出力の置き場がリポジトリの中なら断る（口は叩かない）', async () => {
  const prompts: string[] = []
  const x = io({ factory: fakeFactory(prompts) })
  assert.equal(await run(['--out', join(REPO_ROOT, '.screenshots', 'eval')], x), 2)
  assert.match(x.stderr.join('\n'), /リポジトリの外/)
  assert.equal(prompts.length, 0)
  assert.equal(insideRepo(REPO_ROOT), true)
  assert.equal(insideRepo(dir), false)
})

test('run: 口が claude なら --claude を付けたときだけ回す', async () => {
  const prompts: string[] = []
  const x = io({ factory: fakeFactory(prompts) })
  assert.equal(await run(['--provider', 'claude', '--out', join(dir, 'out-claude')], x), 2)
  assert.match(x.stderr.join('\n'), /--claude/)
  assert.equal(prompts.length, 0)
  const seen: string[] = []
  const y = io({ factory: (provider, model) => (seen.push(`${provider}/${model}`), fakeFactory()(provider, model)) })
  assert.equal(await run(['--provider', 'claude', '--claude', '--out', join(dir, 'out-claude')], y), 0)
  assert.deepEqual(seen, ['claude/fake-model'])
})

test('run: 使い方の誤りは 2', async () => {
  for (const argv of [['--runs', '0'], ['--variants', 'nope'], ['--days', '3'], ['--feed', '--cases', 'x.json'], ['--persona', 'XXXX'], ['--model', '-x'], ['extra']]) {
    assert.equal(await run(argv, io()), 2, argv.join(' '))
  }
})

test('run --feed: 記録の実際の返答を事例にする（読むだけ）。ID は連番で、本文は置き場の外にだけ残る', async () => {
  const feed = await mkdtemp(join(tmpdir(), 'sai-digest-eval-feed-'))
  try {
    await writeFile(join(feed, 'settings.json'), JSON.stringify({ digest_provider: 'openai', digest_model: 'fake-model' }))
    const row = (ts: string, extra: Record<string, unknown>) => JSON.stringify({ ts, agent: 'claude', session: 'session-a', repo: 'repo-a', project: 'owner-a/repo-a', cwd: '/work/repo-a', event: 'Stop', ...extra })
    const file = join(feed, `${localDate(NOW.toISOString())}.jsonl`)
    await writeFile(
      file,
      [
        row('2026-03-04T01:00:00Z', { user_text: '足して', text: '絞り込みを足しました。' }),
        row('2026-03-04T01:10:00Z', { event: 'UserPromptSubmit', user_text: '次' }),
        row('2026-03-04T01:20:00Z', { project: 'owner-a/repo-b', user_text: '消して', text: '古い画像を消しました。' }),
        row('2026-03-04T01:30:00Z', { text: '' }),
      ].join('\n') + '\n',
    )
    const original = await readFile(file, 'utf-8')
    assert.deepEqual((await feedCases(feed, { days: 1, n: 30, project: '' }, NOW)).map((c) => [c.id, c.ask, c.shape]), [['feed-001', '足して', 'feed'], ['feed-002', '消して', 'feed']])
    assert.deepEqual((await feedCases(feed, { days: 1, n: 30, project: 'owner-a/repo-b' }, NOW)).map((c) => c.text), ['古い画像を消しました。'])
    assert.deepEqual((await feedCases(feed, { days: 1, n: 1, project: '' }, NOW)).map((c) => c.ask), ['消して'])
    const out = join(dir, 'out-feed')
    const x = io({ dir: feed })
    assert.equal(await run(['--feed', '--days', '1', '--out', out], x), 0)
    const text = x.stdout.join('\n') + x.stderr.join('\n')
    assert.match(text, /記録の実際の返答/)
    assert.doesNotMatch(text, /絞り込み|古い画像|session-a/)
    assert.deepEqual((await outputs(out)).map((s) => s.case), ['feed-001', 'feed-002'])
    assert.match(await readFile(join(out, 'cases.jsonl'), 'utf-8'), /絞り込みを足しました/)
    // 置き場には何も書いていない
    assert.equal(await readFile(file, 'utf-8'), original)
  } finally {
    await rm(feed, { recursive: true, force: true })
  }
})
