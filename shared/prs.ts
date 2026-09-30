// GitHub に出ている PR を SAI で見る（#524）。`gh` の出力の読み方と、どのリポジトリを並べるかの判定。
// DOM にもプロセスにも触らない純粋関数なので、サーバ（server/git/prs.ts）と画面の両方から使い、prs.test.ts で回す。
//
// **読むだけ**で、GitHub には何も書かない（書く口は #526 で、別に縛る）。
import { parseUnifiedDiff } from './diff.ts'
import { normalizeRemote, projectFromRemote, remoteHost } from './project.ts'
import type { DiffFileStat, PrCheckState, PrRepo, PrSummary } from './types.ts'

/** `owner/repo` の形か。`gh --repo` に渡すので、フラグに化けるもの（先頭の `-`）や空白・`..` は通さない */
export function isRepoName(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.startsWith('-') && !repo.includes('..')
}

/** PR 番号として受けてよい形か（数字だけ。0 と桁の多すぎるものは断る） */
export function isPrNumber(n: string): boolean {
  return /^[1-9][0-9]{0,8}$/.test(n)
}

/**
 * セッションの remote から GitHub の `owner/repo`。GitHub 以外（`gh` が読めない）と読めない形は空。
 * `gh --repo` は github.com を既定に取るので、ほかのホストは並べない（GitHub Enterprise は `gh` の設定次第なので後回し）
 */
export function githubRepoOf(remote: string | undefined): string {
  const url = normalizeRemote(remote) || (remote ?? '').trim()
  if (remoteHost(url) !== 'github.com') return ''
  const repo = projectFromRemote(url)
  return isRepoName(repo) ? repo : ''
}

/**
 * 並べるリポジトリ。**SAI が記録で知っているもの**（セッションの remote が GitHub のもの）だけで、
 * 画面から任意のリポジトリ名を受けて `gh` に渡すことはしない。出てきた順（= 新しいセッションの順）のまま重複を落とす。
 * **重複は大文字小文字を見ずに落とし、最初に出てきた書き方を残す**（GitHub の名前は大文字小文字を区別しないので、
 * origin の書き方が違うだけの worktree があると、同じリポジトリの PR が 2 回並び `gh` も 2 倍叩いていた。#533 のレビュー）
 */
export function knownRepos(sessions: readonly { remote?: string }[]): string[] {
  const seen = new Map<string, string>()
  for (const s of sessions) {
    const repo = githubRepoOf(s.remote)
    if (repo && !seen.has(repo.toLowerCase())) seen.set(repo.toLowerCase(), repo)
  }
  return [...seen.values()]
}

/** 大文字小文字を見ずに、知っているリポジトリの中から名前を引く（URL に書かれた形の揺れを吸う）。無ければ空 */
export function pickKnownRepo(known: readonly string[], repo: string): string {
  const want = repo.toLowerCase()
  return known.find((r) => r.toLowerCase() === want) ?? ''
}

/** GitHub のチェックの状態を 1 つにまとめる。どれか落ちていれば failure、終わっていないものがあれば pending */
export function checkState(rollup: unknown): PrCheckState {
  if (!Array.isArray(rollup) || rollup.length === 0) return ''
  let pending = false
  for (const c of rollup) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    // CheckRun は status + conclusion、StatusContext（古い commit status）は state
    const conclusion = String(o.conclusion ?? o.state ?? '').toUpperCase()
    const status = String(o.status ?? '').toUpperCase()
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion)) return 'failure'
    if ((status && status !== 'COMPLETED') || conclusion === 'PENDING' || conclusion === 'EXPECTED' || conclusion === '') pending = true
  }
  return pending ? 'pending' : 'success'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** `gh pr list` / `gh pr view` の 1 件を PrSummary にする。番号が無ければ null */
export function prFromGh(obj: unknown): PrSummary | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const number = num(o.number)
  if (!number) return null
  const author = o.author && typeof o.author === 'object' ? str((o.author as Record<string, unknown>).login) : ''
  return {
    number,
    title: str(o.title),
    author,
    head: str(o.headRefName),
    base: str(o.baseRefName),
    draft: o.isDraft === true,
    updated_at: str(o.updatedAt),
    url: str(o.url),
    additions: num(o.additions),
    deletions: num(o.deletions),
    changed_files: num(o.changedFiles),
    review_decision: str(o.reviewDecision),
    checks: checkState(o.statusCheckRollup),
    requested: false,
  }
}

/** `gh pr list --json …` の出力。読めなければ null（「PR が無い」の空配列と分ける） */
export function parsePrList(stdout: string): PrSummary[] | null {
  let arr: unknown
  try {
    arr = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(arr)) return null
  return arr.map(prFromGh).filter((p): p is PrSummary => p !== null)
}

/** `gh pr list --search review-requested:@me --json number` の出力から番号の集合。読めなければ空 */
export function parseRequested(stdout: string): Set<number> {
  try {
    const arr: unknown = JSON.parse(stdout)
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.map((o) => num((o as Record<string, unknown> | null)?.number)).filter((n) => n > 0))
  } catch {
    return new Set()
  }
}

/**
 * 並べる順。**自分にレビューを頼まれているものを先に**、その中と残りは新しく動いた順。
 * 下書き（draft）は頼まれていても後ろに回さない（頼まれているなら見る必要がある）
 */
export function sortPrs(prs: readonly PrSummary[]): PrSummary[] {
  return [...prs].sort((a, b) => Number(b.requested) - Number(a.requested) || b.updated_at.localeCompare(a.updated_at) || b.number - a.number)
}

/**
 * unified diff からファイルの見出し（状態と行数）。`gh pr diff` は numstat を出さないので本文から数える。
 * **本文を切る前の patch で数える**（切ったあとだと、大きくて落としたファイルの行数が 0 になる）
 */
export function diffStats(patch: string): DiffFileStat[] {
  return parseUnifiedDiff(patch).map((f) => {
    let added = 0
    let removed = 0
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind === 'add') added++
        else if (l.kind === 'del') removed++
      }
    }
    const status: DiffFileStat['status'] = f.binary ? 'binary' : f.status === 'untracked' ? 'added' : f.status
    const stat: DiffFileStat = { path: f.path || f.oldPath, status, added, removed }
    if (f.oldPath && f.oldPath !== f.path) stat.old_path = f.oldPath
    return stat
  })
}

/** PR 1 本の画面の hash（`#/pr/<owner>/<repo>/<番号>`） */
export function prHash(repo: string, number: number): string {
  return `#/pr/${repo}/${number}`
}

/**
 * セッションに紐づく PR（#548）。**セッションの remote の `owner/repo` とブランチが、PR のリポジトリと head のブランチに
 * 一致するもの**。一覧（`GET /api/prs`）の open な PR から引くので、セッションごとに `gh` を叩かない。
 * 既定のブランチ（PR の base と同じ名前。`main` など）にいるセッションは結ばない（fork から `main` を head にした PR を拾わない）。
 * 同じブランチに 2 本あれば新しく動いた方。リポジトリ名は大文字小文字を見ない（`knownRepos()` と同じ）
 */
export function prForSession(session: { remote?: string; branch?: string }, repos: readonly PrRepo[]): { repo: string; pr: PrSummary } | null {
  const repo = githubRepoOf(session.remote)
  const branch = session.branch ?? ''
  if (!repo || !branch) return null
  const found = repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase())
  if (!found) return null
  const hits = found.prs.filter((p) => p.head === branch && p.base !== branch)
  if (hits.length === 0) return null
  const pr = hits.reduce((a, b) => (b.updated_at > a.updated_at ? b : a))
  return { repo: found.repo, pr }
}
