// 人の判断待ち（「決めること」）を、このリポジトリの issue と PR から拾って 1 つの一覧にする（#762）。**読むだけ**。
//
//   pnpm decisions              open な issue と PR、直近 14 日に閉じた issue の、まだ決まっていない項目
//   pnpm decisions --days 30    閉じた issue を遡る日数
//   pnpm decisions --json       1 行 1 項目の JSON
//
// 拾い方は `decisionsRead.ts`（見出しと箇条書きを読むだけ。LLM は呼ばない）、`gh` の形は `server/git/issues.ts`（決め打ちの 3 形）。
// 出すのは番号・題名・項目の 1 行・日付・おすすめの 1 行だけ（本文は載せない。#688）。`SAI_GH=0` なら何も引かない。
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { RealGit } from '../git/diff.ts'
import { ISSUES_CLOSED_LIMIT, ISSUES_OPEN_LIMIT, issuesFromEnv } from '../git/issues.ts'
import type { GhIssues } from '../git/issues.ts'
import { githubRepoOf } from '../../shared/prs.ts'
import { parseSources, pendingAll } from './decisionsRead.ts'
import type { DecisionSource, Pending } from './decisionsRead.ts'

export const USAGE = `usage: pnpm decisions [--days <n>] [--json]   （このリポジトリの issue と PR から「決めること」を拾う。gh で読むだけ）

  --days <n>   閉じた issue を何日まで遡るか（既定 14。0 で閉じた issue を引かない）
  --json       1 行 1 項目の JSON で出す`

/** 閉じた issue を遡る日数の既定 */
export const DECISIONS_CLOSED_DAYS = 14
/** 題名をどこまで出すか */
const TITLE_CHARS = 60

export interface Env {
  /** `owner/repo`。分からなければ空 */
  repo: string
  /** `SAI_GH=0` なら null */
  gh: GhIssues | null
  now: Date
  out: (line: string) => void
  err: (line: string) => void
}

const clip = (s: string, max: number): string => ([...s].length > max ? `${[...s].slice(0, max - 1).join('')}…` : s)

const FROM: Record<Pending['from'], string> = { body: '決めること', remaining: 'まだ決めていないこと', closing: '決めないまま閉じること', pr: '人が決めること' }

/** 一覧の文。issue / PR ごとに 1 行の見出しと、項目ごとに 1 行（おすすめがあればもう 1 行） */
export function render(pending: readonly Pending[]): string[] {
  const lines: string[] = []
  let last = ''
  for (const p of pending) {
    const key = `${p.kind}#${p.number}`
    if (key !== last) {
      lines.push(`${p.kind === 'pr' ? 'PR ' : ''}#${p.number}${p.state === 'closed' ? '（閉じた）' : ''} ${clip(p.title, TITLE_CHARS)}`)
      last = key
    }
    lines.push(`  ${p.date} ${FROM[p.from]}${p.n === undefined ? '' : ` ${p.n}`}: ${p.text}`)
    if (p.recommend) lines.push(`    → ${p.recommend}`)
  }
  return lines
}

export async function run(argv: string[], env: Env): Promise<number> {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: { days: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false }))
  } catch {
    env.err(USAGE)
    return 2
  }
  if (values.help) {
    env.out(USAGE)
    return 0
  }
  // 数字だけ（空・`1e1`・`0x10` は受けない）
  const days = values.days === undefined ? DECISIONS_CLOSED_DAYS : /^\d{1,3}$/.test(values.days) ? Number(values.days) : -1
  if (days < 0 || days > 365) {
    env.err(USAGE)
    return 2
  }
  if (!env.gh) {
    env.err('gh を使わない設定です（SAI_GH=0）。何も引きません')
    return 0
  }
  if (!env.repo) {
    env.err('このディレクトリのリポジトリ（origin の owner/repo）が分かりません')
    return 1
  }
  // GitHub の検索は日付を UTC で読むので、UTC の日付で切る（Asia/Tokyo の日付だと、古い側が 9 時間ぶん欠ける）
  const since = new Date(env.now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
  const [open, closed, prs] = await Promise.all([
    env.gh.open(env.repo).then((s) => parseSources(s, 'issue', 'open')),
    days > 0 ? env.gh.closed(env.repo, since).then((s) => parseSources(s, 'issue', 'closed')) : Promise.resolve([] as DecisionSource[]),
    env.gh.prs(env.repo).then((s) => parseSources(s, 'pr', 'open')),
  ])
  // 引けなかったものは「0 件」と混ぜない
  const missed = [open ? '' : 'open な issue', closed ? '' : '閉じた issue', prs ? '' : 'PR'].filter(Boolean)
  if (missed.length) env.err(`gh で引けませんでした: ${missed.join('・')}（gh が無い・未ログイン・時間切れ）`)
  const pending = pendingAll([...(open ?? []), ...(closed ?? []), ...(prs ?? [])])
  if (values.json) {
    for (const p of pending) env.out(JSON.stringify(p))
  } else {
    const count = (kind: Pending['kind'], state: Pending['state']) => pending.filter((p) => p.kind === kind && p.state === state).length
    const where = new Set(pending.map((p) => `${p.kind}#${p.number}`)).size
    env.out(`まだ決まっていないこと: ${pending.length} 件（${where} か所。open な issue ${count('issue', 'open')}・閉じた issue ${count('issue', 'closed')}・PR ${count('pr', 'open')}。閉じた issue は ${since} 以降）`)
    for (const line of render(pending)) env.out(line)
  }
  // 上限に届いたら、切れているかもしれないと知らせる（黙って古い側を落とさない）
  if (closed && closed.length >= ISSUES_CLOSED_LIMIT) env.err(`閉じた issue が ${ISSUES_CLOSED_LIMIT} 件に届いたので、古い側が切れているかもしれません（--days を小さく）`)
  if (open && open.length >= ISSUES_OPEN_LIMIT) env.err(`open な issue が ${ISSUES_OPEN_LIMIT} 件に届いたので、古い側が切れているかもしれません`)
  if (prs && prs.length >= ISSUES_OPEN_LIMIT) env.err(`open な PR が ${ISSUES_OPEN_LIMIT} 件に届いたので、古い側が切れているかもしれません`)
  return missed.length ? 1 : 0
}

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
  // このリポジトリ = cwd の origin。GitHub のものだけ（ほかのホストの origin から、github.com の同じ名前を引きに行かない）
  const remote = await new RealGit().run(process.cwd(), ['remote', 'get-url', 'origin']).catch(() => '')
  process.exitCode = await run(process.argv.slice(2), {
    repo: githubRepoOf(remote.trim()),
    gh: issuesFromEnv(),
    now: new Date(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
}
