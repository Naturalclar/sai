// セッションの worktree の差分を git から読む（#171）。GitHub は見に行かない。
//
//   GET /api/sessions/<id>/diff
//     → base を決める（origin/HEAD → origin/main → origin/master → main → master）
//     → ブランチの差分（base...HEAD）と未コミット（HEAD からの差分 + 追跡外のファイル名）
//
// **読むだけ**。checkout / stash / add のような書き込むコマンドは呼ばない（run() が弾く）。
// cwd はセッションの行から取り、リクエストからは受けない（返信と同じ）。
import { spawn } from 'node:child_process'
import { SKIPPED_MARK } from '../../shared/diff.ts'
import type { DiffCounts, DiffFileStat, DiffSection, DiffStatusCode } from '../../shared/types.ts'

/** 本文の上限。全体（1 セクション）と 1 ファイル。この repo の PR 1 つが 61KB 程度なので普段は切れない */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024
export const MAX_FILE_DIFF_BYTES = 200 * 1024
/** git の出力をこれ以上は読まない（メモリの保険）。上限で切った後の判定に影響しないよう十分大きく取る */
export const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024

/** 呼んでよい git のサブコマンド。書き込むものは入れない */
const READ_ONLY = new Set(['rev-parse', 'symbolic-ref', 'merge-base', 'diff', 'ls-files', 'status'])
/**
 * サブコマンド自体は書き込めるが、この動詞なら読むだけ、というもの。
 * `remote get-url` は origin の URL を読むだけ（`remote add` などは弾く）
 */
const READ_ONLY_VERBS: Record<string, Set<string>> = { remote: new Set(['get-url']) }

/** git を叩く口。テストでは差し替える */
export interface Git {
  /** stdout を返す。失敗（git が無い、リポジトリでない）は reject */
  run(cwd: string, args: string[]): Promise<string>
}

export class RealGit implements Git {
  readonly bin: string
  constructor(bin: string = process.env.SAI_GIT_BIN || 'git') {
    this.bin = bin
  }
  run(cwd: string, args: string[]): Promise<string> {
    const words = args.filter((a) => !a.startsWith('-'))
    const [sub, verb] = [words[0], words[1]]
    const ok = Boolean(sub) && (READ_ONLY.has(sub!) || Boolean(verb && READ_ONLY_VERBS[sub!]?.has(verb)))
    if (!ok) return Promise.reject(new Error(`読むだけのコマンドしか呼ばない: ${[sub, verb].filter(Boolean).join(' ') || '(無し)'}`))
    return new Promise((resolve, reject) => {
      // --no-pager と color.ui=false で、人の設定に関係なく素の出力にする
      const child = spawn(this.bin, ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      let over = false
      child.stdout.on('data', (c: Buffer) => {
        if (out.length > MAX_GIT_OUTPUT_BYTES) {
          over = true
          return
        }
        out += c.toString()
      })
      child.stderr.on('data', (c: Buffer) => (err += c.toString()))
      child.once('error', reject)
      child.once('close', (code) => (code === 0 || over ? resolve(out) : reject(new Error(err.trim() || `git exited ${code}`))))
    })
  }
}

/** git が読めない（cwd が消えた、git じゃない、git が無い） */
export class NotAGitRepo extends Error {}

/** base に使ってよい形か。フラグに化けるもの（先頭の `-`）と空白入りは断る。シェルは通さないので他は git に任せる */
export function validBase(base: string): boolean {
  return base !== '' && !base.startsWith('-') && !/[\s'"\\]/.test(base)
}

/**
 * 比べる相手。origin/HEAD は **bare clone だと未設定で失敗する**ので、ローカルで順に探す（ネットワークは叩かない）。
 * 見つからなければ空（ブランチの差分は出せないが、未コミットは出せる）
 */
export async function resolveBase(git: Git, cwd: string, want = ''): Promise<string> {
  const exists = async (ref: string): Promise<boolean> => {
    try {
      await git.run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      return true
    } catch {
      return false
    }
  }
  if (want) return validBase(want) && (await exists(want)) ? want : ''
  try {
    const head = (await git.run(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])).trim()
    if (head && (await exists(head))) return head
  } catch {
    // bare clone だと未設定で失敗する。下の候補に落ちる
  }
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await exists(ref)) return ref
  }
  return ''
}

/** `git diff --name-status` の1文字を読む。`R100` のような数字付きも来る */
function statusOf(code: string): DiffStatusCode {
  switch (code.charAt(0)) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'M':
    case 'T':
      return 'modified'
    default:
      return 'other'
  }
}

/** `--numstat` と `--name-status` を突き合わせて 1 ファイル 1 行にする。バイナリは `-` なので 0 行 */
export function parseStats(numstat: string, nameStatus: string): DiffFileStat[] {
  const status = new Map<string, { status: DiffStatusCode; oldPath: string }>()
  for (const line of nameStatus.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 2 || !parts[0]) continue
    const kind = statusOf(parts[0])
    // リネームは `R100\told\tnew`
    const path = parts.length >= 3 ? parts[2]! : parts[1]!
    status.set(path, { status: kind, oldPath: parts.length >= 3 ? parts[1]! : '' })
  }
  const files: DiffFileStat[] = []
  for (const line of numstat.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [add, del] = [parts[0]!, parts[1]!]
    // リネームは `0\t0\told => new` の形になることがある（-z を使わない場合）
    const raw = parts[2]!
    const arrow = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
    const path = arrow ? `${arrow[1]}${arrow[3]}${arrow[4]}` : raw.includes(' => ') ? raw.split(' => ')[1]! : raw
    const hit = status.get(path)
    files.push({
      path,
      old_path: hit?.oldPath || undefined,
      status: add === '-' && del === '-' ? 'binary' : (hit?.status ?? 'modified'),
      added: add === '-' ? 0 : Number(add) || 0,
      removed: del === '-' ? 0 : Number(del) || 0,
    })
  }
  return files
}

/**
 * ファイル単位で上限に収める。1 ファイルが大きすぎればその本文だけ落とし（印を残す）、
 * 全体が上限を超えたらそこで打ち切る。どちらでも truncated を立てる。
 * ファイルの一覧（stats）は常に全部返すので、切れても「何が変わったか」は分かる
 */
export function clampPatch(patch: string, maxTotal = MAX_DIFF_BYTES, maxFile = MAX_FILE_DIFF_BYTES): { patch: string; truncated: boolean } {
  // どちらの上限にも収まっていれば切る必要はない（普段はここで返る）
  if (patch.length <= Math.min(maxFile, maxTotal)) return { patch, truncated: false }
  const chunks = patch.split(/\n(?=diff --git )/)
  const out: string[] = []
  let total = 0
  let truncated = false
  for (const chunk of chunks) {
    if (total + chunk.length > maxTotal) {
      truncated = true
      break
    }
    if (chunk.length > maxFile) {
      // 見出し（diff --git の行）だけ残して本文を落とす
      const head = chunk.split('\n')[0] ?? ''
      const cut = `${head}\n${SKIPPED_MARK}`
      out.push(cut)
      total += cut.length
      truncated = true
      continue
    }
    out.push(chunk)
    total += chunk.length + 1
  }
  return { patch: out.join('\n'), truncated }
}

/**
 * いま居るところ。`branch` は detached だと空（PR を引くときはブランチ名でないと使えないので分けて返す）、
 * `head` は表示用でブランチ名か短い SHA
 */
export async function headRef(git: Git, cwd: string): Promise<{ head: string; branch: string }> {
  try {
    const branch = (await git.run(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'])).trim()
    if (branch) return { head: branch, branch }
  } catch {
    // detached
  }
  try {
    return { head: (await git.run(cwd, ['rev-parse', '--short', 'HEAD'])).trim(), branch: '' }
  } catch {
    return { head: '', branch: '' }
  }
}

/** そのセッションの worktree が今いるブランチ。detached なら短い SHA */
export async function headOf(git: Git, cwd: string): Promise<string> {
  return (await headRef(git, cwd)).head
}

/**
 * 大きさだけ（#211）。`--numstat` 1 回で済むので、本文を作る section() よりずっと軽い。
 * `--name-status` も要らない（status は使わないので `parseStats` は通さない）
 */
async function counts(git: Git, cwd: string, args: string[]): Promise<{ counts: DiffCounts; paths: string[] }> {
  const numstat = await git.run(cwd, ['diff', '--numstat', ...args])
  const paths: string[] = []
  let added = 0
  let removed = 0
  for (const line of numstat.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [add, del] = [parts[0]!, parts[1]!]
    paths.push(parts[2]!)
    // バイナリは `-`。ファイルとしては数えるが行は数えない
    added += add === '-' ? 0 : Number(add) || 0
    removed += del === '-' ? 0 : Number(del) || 0
  }
  return { counts: { files: paths.length, added, removed }, paths }
}

export interface SessionDiffSummary {
  base: string
  head: string
  /** いま居るブランチ。detached なら空（PR を引くのに使う） */
  head_branch: string
  /** 変わったファイルの数（両方に出るファイルは 1 つ） */
  files: number
  added: number
  removed: number
  branch: DiffCounts
  working: DiffCounts
  untracked: number
}

const NO_COUNTS: DiffCounts = { files: 0, added: 0, removed: 0 }

/**
 * `sessionDiff()` の軽い版。patch を作らないので、開く前の「行数」を出すのに使える（#211）。
 * base が決まらなければブランチの差分は 0 で、未コミットだけ返す
 */
export async function sessionDiffSummary(git: Git, cwd: string, want = ''): Promise<SessionDiffSummary> {
  if (!cwd) throw new NotAGitRepo('作業ディレクトリが分かりません')
  try {
    await git.run(cwd, ['rev-parse', '--git-dir'])
  } catch (err) {
    throw new NotAGitRepo(err instanceof Error ? err.message : String(err))
  }
  const [base, ref] = await Promise.all([resolveBase(git, cwd, want), headRef(git, cwd)])
  const [branch, working, untracked] = await Promise.all([
    base ? counts(git, cwd, [`${base}...HEAD`]) : Promise.resolve({ counts: NO_COUNTS, paths: [] as string[] }),
    counts(git, cwd, ['HEAD']),
    git
      .run(cwd, ['ls-files', '--others', '--exclude-standard'])
      .then((out) => out.split('\n').filter(Boolean).length)
      .catch(() => 0),
  ])
  return {
    base,
    head: ref.head,
    head_branch: ref.branch,
    // 同じファイルがブランチの差分と未コミットの両方に出ることがあるので、重複は 1 つに畳む
    files: new Set([...branch.paths, ...working.paths]).size,
    added: branch.counts.added + working.counts.added,
    removed: branch.counts.removed + working.counts.removed,
    branch: branch.counts,
    working: working.counts,
    untracked,
  }
}

async function section(git: Git, cwd: string, args: string[]): Promise<DiffSection> {
  const [numstat, nameStatus, raw] = await Promise.all([
    git.run(cwd, ['diff', '--numstat', ...args]),
    git.run(cwd, ['diff', '--name-status', ...args]),
    git.run(cwd, ['diff', ...args]),
  ])
  const { patch, truncated } = clampPatch(raw)
  return { files: parseStats(numstat, nameStatus), patch, truncated }
}

export interface SessionDiff {
  base: string
  head: string
  branch: DiffSection
  working: DiffSection
  untracked: string[]
}

/**
 * ブランチの差分（base...HEAD。merge-base から）と、未コミット（HEAD からの差分 + 追跡外のファイル名）。
 * cwd が git のリポジトリでなければ NotAGitRepo。base が決まらなければブランチの差分は空で返す
 */
export async function sessionDiff(git: Git, cwd: string, want = ''): Promise<SessionDiff> {
  if (!cwd) throw new NotAGitRepo('作業ディレクトリが分かりません')
  try {
    await git.run(cwd, ['rev-parse', '--git-dir'])
  } catch (err) {
    throw new NotAGitRepo(err instanceof Error ? err.message : String(err))
  }
  const empty: DiffSection = { files: [], patch: '', truncated: false }
  const [base, head] = await Promise.all([resolveBase(git, cwd, want), headOf(git, cwd)])
  const [branch, working, untracked] = await Promise.all([
    base ? section(git, cwd, [`${base}...HEAD`]) : Promise.resolve(empty),
    section(git, cwd, ['HEAD']),
    git
      .run(cwd, ['ls-files', '--others', '--exclude-standard'])
      .then((out) => out.split('\n').filter(Boolean))
      .catch(() => []),
  ])
  return { base, head, branch, working, untracked }
}
