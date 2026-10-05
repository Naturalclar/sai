// 一言（digest）のプロンプトの案を、決まった事例で比べる道具（#712）。**手元で回すもの**（口を叩くので CI には載せない）。
//
//   pnpm digest:eval                              今のプロンプトを、作り物の事例（cases.json）で 1 回ずつ
//   pnpm digest:eval --variants current,bare --runs 3   2 つの案を同じ事例・同じ回数で比べる（最初が今の案）
//   pnpm digest:eval --feed --days 7 -n 50        ~/.agent-feed の実際の返答を事例にする（読むだけ。守ることは無い）
//
// 口とモデルは `settings.json`（画面の設定）から読み、送り先は `SAI_DIGEST_URL`（サーバと同じ）。`claude` の口は `--claude` を付けたときだけ。
// **標準出力に出すのは件数と割合だけ**。本文と一言は `--out`（既定は一時ディレクトリ。リポジトリの中は断る）の `outputs.jsonl` にだけ残る。
// 終了コード: 0 通す条件を満たした・1 満たしていない／口が全部落ちた・2 使い方の誤り
import { realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { isDigestModel, isDigestProvider } from '../../../shared/digestSettings.ts'
import { needsFullText } from '../../../shared/fullText.ts'
import { isPersonaId } from '../../../shared/persona.ts'
import { rowProject } from '../../../shared/project.ts'
import type { DigestProvider, PersonaId } from '../../../shared/types.ts'
import { DEFAULT_DIGEST_MODEL, DEFAULT_OPENAI_URL, summarizerFactory } from '../../digest/digest.ts'
import type { Summarizer, SummarizerFactory } from '../../digest/digest.ts'
import { SETTINGS_FILE, SettingsStore } from '../../meta/settings.ts'
import { dateRange, feedDir, isTurn, readRows } from '../feedRead.ts'
import { report } from './report.ts'
import type { Sample } from './report.ts'
import { scoreSummary, SHAPE_LABELS, validateCases } from './score.ts'
import type { EvalCase, Shape } from './score.ts'
import { pickVariants } from './variants.ts'
import type { Variant } from './variants.ts'

export const USAGE = `usage: pnpm digest:eval [options]   （一言のプロンプトの案を、同じ事例・同じ回数で比べる。手元で回す）

  --variants <a,b>    比べる案（最初が今の案。既定 current）   --runs <数>   事例 1 つを何回回すか（既定 1）
  --cases <パス>      事例のファイル（既定は作り物の cases.json）
  --feed              ~/.agent-feed の実際の返答を事例にする（読むだけ）。--days（既定 7）・-n（既定 30）・--project で絞る
  --provider / --model / --persona   口・モデル・性格（既定は settings.json）。claude の口は --claude を付けたときだけ
  --include-asking    人に聞いている返答（本番では一言にしない。#638）も回す
  --out <ディレクトリ>  本文と一言を残す先（既定は一時ディレクトリ。リポジトリの中は断る）`

/** 作り物の事例の置き場 */
export const CASES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'cases.json')
/** リポジトリの根（`server/tools/digest-eval/` の 3 つ上）。出力をここの中に置かせない */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export const DEFAULT_FEED_CASES = 30
export const DEFAULT_FEED_DAYS = 7
export const MAX_RUNS = 20

export interface Io {
  /** 記録の置き場（`settings.json` と `--feed` の読み先） */
  dir: string
  now: Date
  env: NodeJS.ProcessEnv
  out: (line: string) => void
  err: (line: string) => void
  /** 口の作り方。既定は本物（サーバと同じ `summarizerFactory()`）。テストは偽物を渡す */
  factory?: SummarizerFactory
}

/** 事例のファイルを読む。形が違えば文を並べて投げる */
export async function loadCases(path: string): Promise<EvalCase[]> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf-8'))
  const errors = validateCases(raw)
  if (errors.length > 0) throw new Error(`事例のファイルが読めません（${path}）:\n${errors.map((e) => `  ${e}`).join('\n')}`)
  return raw as EvalCase[]
}

/**
 * 記録の実際の返答を事例にする（ターン完了で本文のある行。新しい方から n 件）。**読むだけ**で、読み方は `feedRead.ts`。
 * ID は連番にする（セッションの ID を出力に持ち込まない）。守ることは無いので、採点は `digestIssues()` だけ
 */
export async function feedCases(dir: string, opts: { days: number; n: number; project: string }, now: Date): Promise<EvalCase[]> {
  const rows = (await readRows(dir, dateRange({ days: opts.days }, now))).filter((r) => isTurn(r) && Boolean(r.text?.trim()) && (!opts.project || rowProject(r) === opts.project))
  return rows.slice(-opts.n).map((r, i) => ({ id: `feed-${String(i + 1).padStart(3, '0')}`, shape: 'feed' as const, ask: r.user_text ?? '', text: r.text ?? '' }))
}

export interface EvalRun {
  samples: Sample[]
  /** 人に聞いている返答なので回さなかった事例の ID（本番では一言にしない。#638） */
  skipped: string[]
}

/**
 * 事例 × 回 × 案を順に回す。**同じ事例・同じ回を、案を続けて回す**（口の調子が途中で変わっても、案の間で同じ条件になる）。
 * 口が落ちた回は `error` を持つ行として残し、止めない
 */
export async function runEval(opts: {
  cases: readonly EvalCase[]
  variants: readonly Variant[]
  runs: number
  persona: PersonaId
  summarizer: Summarizer
  includeAsking?: boolean
  progress?: (line: string) => void
}): Promise<EvalRun> {
  const samples: Sample[] = []
  const skipped: string[] = []
  const todo = opts.cases.filter((c) => {
    if (opts.includeAsking || !needsFullText(c.text)) return true
    skipped.push(c.id)
    return false
  })
  let done = 0
  const total = todo.length * opts.runs * opts.variants.length
  for (const c of todo) {
    for (let turn = 1; turn <= opts.runs; turn++) {
      for (const v of opts.variants) {
        const base = { case: c.id, shape: c.shape, variant: v.id, run: turn }
        try {
          const summary = (await v.make({ persona: opts.persona, text: c.text, ask: c.ask }, (prompt) => opts.summarizer.summarize(prompt))).trim()
          samples.push({ ...base, summary, chars: [...summary].length, codes: scoreSummary(c, summary) })
        } catch (err) {
          samples.push({ ...base, summary: '', chars: 0, codes: [], error: err instanceof Error ? err.message : String(err) })
        }
        done++
        opts.progress?.(`[${done}/${total}] ${c.id} ${v.id}${samples[samples.length - 1]!.error ? ' 口の失敗' : ''}`)
      }
    }
  }
  return { samples, skipped }
}

/** 出力の置き場がリポジトリの中か（実際の返答と一言が入るので、コミットできる場所に置かせない） */
export function insideRepo(path: string, root: string = REPO_ROOT): boolean {
  // まだ無いパスは、在る所まで遡って実体を引き、残りを繋ぐ（リンク越しの「これから作る」置き場を外と見誤らない。#716 のレビュー）
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      const parent = dirname(p)
      return parent === p ? p : join(real(parent), basename(p))
    }
  }
  const target = real(resolve(path))
  const base = real(root)
  return target === base || target.startsWith(base + sep)
}

interface Options {
  variants: Variant[]
  runs: number
  casesPath: string
  feed: boolean
  days: number
  n: number
  project: string
  provider?: DigestProvider
  model?: string
  persona?: PersonaId
  claude: boolean
  includeAsking: boolean
  out: string
}

function parse(argv: readonly string[], now: Date): Options | { error: string } {
  // `pnpm digest:eval -- --feed` の先頭の `--` は落とす
  const args = argv[0] === '--' ? argv.slice(1) : argv
  let values: Record<string, string | boolean | undefined>
  try {
    values = parseArgs({
      args: [...args],
      options: {
        variants: { type: 'string' },
        runs: { type: 'string' },
        cases: { type: 'string' },
        feed: { type: 'boolean' },
        days: { type: 'string' },
        n: { type: 'string', short: 'n' },
        project: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        persona: { type: 'string' },
        claude: { type: 'boolean' },
        'include-asking': { type: 'boolean' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }).values
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  if (values.help) return { error: '' }
  const str = (key: string) => (typeof values[key] === 'string' ? (values[key] as string) : undefined)
  const count = (key: string, fallback: number, max: number): number | string => {
    const raw = str(key)
    if (raw === undefined) return fallback
    const v = Number(raw)
    return Number.isInteger(v) && v > 0 && v <= max ? v : `--${key} は 1〜${max} の整数で指定してください: ${raw}`
  }
  const variants = pickVariants(str('variants') ?? 'current')
  if (typeof variants === 'string') return { error: variants }
  const runs = count('runs', 1, MAX_RUNS)
  if (typeof runs === 'string') return { error: runs }
  const days = count('days', DEFAULT_FEED_DAYS, 3650)
  if (typeof days === 'string') return { error: days }
  const n = count('n', DEFAULT_FEED_CASES, 10_000)
  if (typeof n === 'string') return { error: n }
  const feed = !!values.feed
  if (feed && str('cases') !== undefined) return { error: '--feed と --cases は一緒に指定できません' }
  if (!feed) for (const key of ['days', 'n', 'project']) if (values[key] !== undefined) return { error: `--${key} は --feed のときだけ効きます` }
  const provider = str('provider')
  if (provider !== undefined && !isDigestProvider(provider)) return { error: `--provider は claude か openai です: ${provider}` }
  const model = str('model')
  if (model !== undefined && !isDigestModel(model)) return { error: `--model が読めません: ${model}` }
  const persona = str('persona')
  if (persona !== undefined && !isPersonaId(persona)) return { error: `--persona が読めません: ${persona}` }
  const out = resolve(str('out') ?? join(tmpdir(), 'sai-digest-eval', now.toISOString().replace(/[:.]/g, '-')))
  if (insideRepo(out)) return { error: `--out はリポジトリの外にしてください（実際の返答と一言が入るので、コミットできる場所には置かない）: ${out}` }
  return { variants, runs, casesPath: str('cases') ?? CASES_PATH, feed, days, n, project: str('project') ?? '', provider, model, persona, claude: !!values.claude, includeAsking: !!values['include-asking'], out }
}

/** 形ごとの事例の数（`完了の報告 4・…`） */
function shapeNote(cases: readonly EvalCase[]): string {
  const counts = new Map<string, number>()
  for (const c of cases) counts.set(c.shape, (counts.get(c.shape) ?? 0) + 1)
  return [...counts].map(([shape, n]) => `${SHAPE_LABELS[shape as Shape] ?? shape} ${n}`).join('・')
}

/** コマンドを 1 回実行する。返すのは終了コード */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const o = parse(argv, io.now)
  if ('error' in o) {
    if (o.error) io.err(o.error)
    ;(o.error ? io.err : io.out)(USAGE)
    return o.error ? 2 : 0
  }
  // 口・モデル・性格は画面の設定から（読むだけ）。送り先と鍵は環境変数のまま（`summarizerFactory()`）
  const settings = await new SettingsStore(join(io.dir, SETTINGS_FILE)).get()
  const provider = o.provider ?? settings.digest_provider
  // 設定のモデルは、設定の口のもの。口だけ切り替えたときは持ち越さない（手元のモデルの名前を claude に渡さない。#716 のレビュー）
  const saved = provider === settings.digest_provider ? settings.digest_model : ''
  const model = o.model ?? (saved || (provider === 'claude' ? DEFAULT_DIGEST_MODEL : ''))
  const persona = o.persona ?? settings.persona
  if (provider === 'claude' && !o.claude) {
    io.err('口が claude です。回すたびに費用がかかるので、回すなら --claude を付けてください（手元の口で回すなら --provider openai --model <名前>）')
    return 2
  }
  if (!model) {
    io.err('モデルが決まっていません。--model <名前> を付けるか、画面の設定で選んでください')
    return 2
  }
  let cases: EvalCase[]
  try {
    cases = o.feed ? await feedCases(io.dir, { days: o.days, n: o.n, project: o.project }, io.now) : await loadCases(o.casesPath)
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err))
    return 2
  }
  if (cases.length === 0) {
    io.err('事例がありません')
    return 1
  }
  const summarizer = (io.factory ?? summarizerFactory(io.dir, io.env, () => {}))(provider, model)
  const where = provider === 'openai' ? (summarizer.where ?? io.env.SAI_DIGEST_URL ?? DEFAULT_OPENAI_URL) : 'claude'
  io.err(`口: ${where} / ${model} / ${persona}・事例 ${cases.length} 件 × ${o.runs} 回 × 案 ${o.variants.length}（${o.variants.map((v) => v.id).join(', ')}）`)
  const { samples, skipped } = await runEval({ cases, variants: o.variants, runs: o.runs, persona, summarizer, includeAsking: o.includeAsking, progress: io.err })
  const ran = cases.filter((c) => !skipped.includes(c.id))
  const result = report({
    samples,
    variants: o.variants.map((v) => v.id),
    notes: [
      `口: ${provider} / ${model}・性格 ${persona}・${o.runs} 回ずつ`,
      `事例: ${o.feed ? `記録の実際の返答（直近 ${o.days} 日の新しい方から）` : '作り物'} ${ran.length} 件${o.feed ? '' : `（${shapeNote(ran)}）`}`,
      ...(skipped.length > 0 ? [`人に聞いている返答なので回さなかった（本番では一言にしない。#638）: ${skipped.length} 件${o.feed ? '' : `（${skipped.join(', ')}）`}`] : []),
      ...o.variants.map((v) => `\`${v.id}\`: ${v.label}`),
    ],
  })
  // 本文と一言は置き場の外にだけ残す。記録から読んだ事例は、あとで突き合わせられるよう本文も一緒に置く
  await mkdir(o.out, { recursive: true, mode: 0o700 })
  const write = (name: string, body: string) => writeFile(join(o.out, name), body, { mode: 0o600 })
  await write('outputs.jsonl', samples.map((s) => JSON.stringify(s)).join('\n') + '\n')
  await write('report.md', result.lines.join('\n') + '\n')
  if (o.feed) await write('cases.jsonl', cases.map((c) => JSON.stringify(c)).join('\n') + '\n')
  for (const line of result.lines) io.out(line)
  io.err(`一言の中身は ${join(o.out, 'outputs.jsonl')}（リポジトリの外。貼るのは上の数字だけ）`)
  if (samples.length > 0 && samples.every((s) => s.error)) {
    io.err(`口が全部落ちました: ${samples[0]!.error}`)
    return 1
  }
  return result.pass ? 0 : 1
}

/** このファイルを直接起動したか（リンク越しのパスでも当たるよう、実体で比べる） */
function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  process.exitCode = await run(process.argv.slice(2), { dir: feedDir(), now: new Date(), env: process.env, out: (line) => console.log(line), err: (line) => console.error(line) })
}
