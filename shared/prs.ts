// GitHub に出ている PR を SAI で見る（#524）。`gh` の出力の読み方と、どのリポジトリを並べるかの判定。
// DOM にもプロセスにも触らない純粋関数なので、サーバ（server/git/prs.ts）と画面の両方から使い、prs.test.ts で回す。
//
// **読むだけ**で、GitHub には何も書かない（書く口は #526 で、別に縛る）。
import { parseUnifiedDiff } from './diff.ts'
import { normalizeRemote, projectFromRemote, remoteHost } from './project.ts'
import { reviewDecisionOf } from './prReviewState.ts'
import type { DiffFileStat, PrCheckState, PrRef, PrRepo, PrSummary } from './types.ts'
import type { PrCi } from './waits.ts'

/** `owner/repo` の形か。`gh --repo` に渡すので、フラグに化けるもの（先頭の `-`）や空白・`..` は通さない */
export function isRepoName(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.startsWith('-') && !repo.includes('..')
}

/** PR 番号として受けてよい形か（数字だけ。0 と桁の多すぎるものは断る） */
export function isPrNumber(n: string): boolean {
  return /^[1-9][0-9]{0,8}$/.test(n)
}

/** セッションの返答から集める PR の名指しの上限（#888 / #890。あとに出てきたものを残す） */
export const REPLY_PRS_MAX = 30

/**
 * 本文に出てきた PR の名指し（#888 / #890）。出てきた順・重複なし（大文字小文字を見ない）。
 * - GitHub の PR の URL（`https://github.com/<owner>/<repo>/pull/<番号>`）
 * - 素の `PR #N` / `#N`。**`repo`（その行のセッションの GitHub のリモート）が空でないときだけ**、そのリポジトリの番号として読む。
 *   `owner/repo#N`・URL の `#…`・`&#N;` のように前に文字が付いたものは読まない。issue の番号も拾うが、結ぶのは一覧の open な PR に
 *   当たるものだけなので（`prForSession()`）、番号の取り違えは起きない（GitHub の issue と PR は同じ番号の並び）。
 *   `PR #N` の形だけに絞るなら、下の `(?:PR\s?)?` を必須にする（#890 の「決めること」1）
 *
 * 名前と番号は `isRepoName()` / `isPrNumber()` を通ったものだけ
 */
export function prRefsIn(text: string, repo: string): PrRef[] {
  const out: PrRef[] = []
  const seen = new Set<string>()
  const bareRepo = isRepoName(repo) ? repo : ''
  const re = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([0-9]+)(?![0-9])|(?<![A-Za-z0-9_/#&.-])(?:PR\s?)?#([0-9]+)(?![0-9A-Za-z_])/gi
  for (const m of (text ?? '').matchAll(re)) {
    const [, urlRepo = '', urlN = '', bareN = ''] = m
    const ref = urlRepo ? { repo: urlRepo, n: urlN } : { repo: bareRepo, n: bareN }
    if (!ref.repo || !isRepoName(ref.repo) || !isPrNumber(ref.n)) continue
    const key = `${ref.repo.toLowerCase()}#${ref.n}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ repo: ref.repo, number: Number(ref.n) })
    if (out.length >= REPLY_PRS_MAX) break
  }
  return out
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

/** 落ちたチェックの名前（#732。待ちが終わったときに渡す要点）。重複は 1 つにして、出てきた順 */
export function failingChecks(rollup: unknown): string[] {
  if (!Array.isArray(rollup)) return []
  const names: string[] = []
  for (const c of rollup) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    if (checkState([o]) !== 'failure') continue
    const name = [o.name, o.context].find((v): v is string => typeof v === 'string' && v.trim() !== '')?.trim() ?? '（名前なし）'
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** `gh pr view --json state,statusCheckRollup` の出力（#732）。読めなければ null */
export function parsePrCi(stdout: string): PrCi | null {
  let obj: unknown
  try {
    obj = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  if (typeof o.state !== 'string' || !o.state) return null
  const rollup = Array.isArray(o.statusCheckRollup) ? o.statusCheckRollup : []
  // 1 つずつ見て、終わっていないものがあるか（`checkState()` は 1 つ落ちていれば、残りが走っていても failure を返す）
  const pending = rollup.some((c) => checkState([c]) === 'pending')
  return { state: o.state, checks: checkState(rollup), failing: failingChecks(rollup), pending }
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
    // reviewDecision が空（レビューを必須にしていないリポジトリ）なら reviews から組む（#793。判定はここ 1 か所）
    review_decision: reviewDecisionOf(o),
    checks: checkState(o.statusCheckRollup),
    requested: false,
    ...(o.isCrossRepository === true ? { cross: true } : {}),
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
 * **fork のブランチから出た PR（`cross`）は結ばない**（`head` はブランチ名だけなので、同じ名前の他人のブランチを拾う）。
 * 既定のブランチ（PR の base と同じ名前。`main` など）にいるセッションも結ばない。
 * 同じブランチに 2 本あれば新しく動いた方。リポジトリ名は大文字小文字を見ない（`knownRepos()` と同じ）
 *
 * **返答に出てきた PR からも結ぶ**（#888 / #890。`reply_prs`）。結ぶのは**一覧（記録で知っているリポジトリの open な PR）にあるものだけ**で、
 * 無ければ結ばない（`gh` に聞きに行かない）。返答の中では、あとに出てきた方。
 * - ブランチで結べないとき（作業ディレクトリと PR のリポジトリが別の場所にあるセッション。#888）は返答の PR。
 * - **ブランチで当たった PR がそのセッションの返答に一度も出てこず、返答に一覧の別の PR があれば、そちら**（#890）。作業ディレクトリの
 *   中の別の worktree・別のブランチで PR を出すセッションと、同じ worktree を別のセッションがブランチを切り替えて使う形で、
 *   記録のブランチ（作業ディレクトリのその時点のもの）がそのセッションの PR を指さないため。
 * - 返答に一覧の PR が 1 つも無ければ、ブランチの PR（PR の番号を書かないセッションは今までどおり）
 */
export function prForSession(session: { remote?: string; branch?: string; reply_prs?: readonly PrRef[] }, repos: readonly PrRepo[]): { repo: string; pr: PrSummary } | null {
  const byBranch = prByBranch(session, repos)
  const byReply = prByReply(session.reply_prs, repos)
  if (!byBranch || !byReply) return byBranch ?? byReply
  // どちらも当たれば、ブランチの PR が返答に出てきたときだけブランチの方（#890）
  return mentions(session.reply_prs, byBranch) ? byBranch : byReply
}

function mentions(refs: readonly PrRef[] | undefined, hit: { repo: string; pr: PrSummary }): boolean {
  const repo = hit.repo.toLowerCase()
  return (refs ?? []).some((r) => r.number === hit.pr.number && r.repo.toLowerCase() === repo)
}

/**
 * フィードの見出しの PR（#554 / #888）。**見出しのブランチ（その発言を書いたときのもの）で引く**。返答の URL の道（いまの `reply_prs`）を
 * 使うのは、**セッションに GitHub のリモートが無いとき**だけ（リモートのあるセッションでは、ブランチを移る前の発言にいまの PR を付けない。
 * #889 のレビュー）
 */
export function prForHeading(session: { remote?: string; reply_prs?: readonly PrRef[] }, branch: string, repos: readonly PrRepo[]): { repo: string; pr: PrSummary } | null {
  const viaReply = !githubRepoOf(session.remote) && session.reply_prs ? { reply_prs: session.reply_prs } : {}
  return prForSession({ remote: session.remote ?? '', branch, ...viaReply }, repos)
}

function prByBranch(session: { remote?: string; branch?: string }, repos: readonly PrRepo[]): { repo: string; pr: PrSummary } | null {
  const repo = githubRepoOf(session.remote)
  const branch = session.branch ?? ''
  if (!repo || !branch) return null
  const found = repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase())
  if (!found) return null
  const hits = found.prs.filter((p) => p.head === branch && p.base !== branch && !p.cross)
  if (hits.length === 0) return null
  const pr = hits.reduce((a, b) => (b.updated_at > a.updated_at ? b : a))
  return { repo: found.repo, pr }
}

function prByReply(refs: readonly PrRef[] | undefined, repos: readonly PrRepo[]): { repo: string; pr: PrSummary } | null {
  if (!refs) return null
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!
    const found = repos.find((r) => r.repo.toLowerCase() === ref.repo.toLowerCase())
    const pr = found?.prs.find((p) => p.number === ref.number)
    if (found && pr) return { repo: found.repo, pr }
  }
  return null
}
