// GitHub に出ている PR を読む（#524）。一覧・1 本の中身・差分。**書くのはレビューの投稿（#526）の 1 形だけ。**
//
// 差分ボタンの PR 番号（pr.ts。#211）と同じ作法で閉じてある:
//
// - 読むのは下の 5 形だけ（`gh pr list` / `gh pr list --search review-requested:@me` / `gh pr view` / `gh pr diff` / `gh api user`）。
//   コメント（#600）も `gh pr view --json comments,reviews` で、同じ形の項目違い。差分の行に付いたコメントは `gh pr view` では
//   取れないので、`gh api -X GET repos/<owner>/<repo>/pulls/<番号>/comments?per_page=100 --paginate --jq <決め打ち>` を
//   **読むだけの 1 形**として足した（6 形目。`-X GET` を明示し、`-f` / `--input` は付けない）。
//   書くのは `gh api -X POST repos/<owner>/<repo>/pulls/<番号>/reviews --input -` の 1 形だけ（中身は shared/prReview.ts の
//   githubReview() が組み立てたもの。呼ぶ側が同一オリジン・head の SHA・行の位置を確かめてから呼ぶ）。
//   引数はここで組み立て、任意のサブコマンドは作れない。シェルは通さない
// - リポジトリはサーバが**記録で知っているもの**だけ（shared/prs.ts の knownRepos()。呼び出し側が確かめる）、
//   番号は数字だけ（isPrNumber()）。ここでも形をもう一度確かめる
// - 認証は `gh` に任せる（SAI は鍵を持たない）。`gh` が無い・未ログイン・時間切れは **null を返すだけ**
// - `SAI_GH=0` で丸ごと切れる（NoPrs）。実行ファイルはサーバの PATH の `gh`（#288）
// - チェックアウトも fetch もしない（`RealGit` の「読むだけ」の外に出ない）
import { spawn } from 'node:child_process'
import { isPrNumber, isRepoName, parsePrList, parseRequested, prFromGh, sortPrs } from '../../shared/prs.ts'
import type { GithubReview } from '../../shared/prReview.ts'
import { githubErrorText } from '../../shared/prReview.ts'
import { parsePrComments } from '../../shared/prComments.ts'
import type { PrCommentList } from '../../shared/prComments.ts'
import { LINE_COMMENTS_JQ, parsePrLineComments } from '../../shared/prLineComments.ts'
import type { PrLineCommentList } from '../../shared/prLineComments.ts'
import type { PrSummary } from '../../shared/types.ts'

/** 1 回の `gh` を諦めるまで。一覧はリポジトリの数だけ並べて走らせる */
export const PRS_TIMEOUT_MS = 10_000
/** 一覧を引き直さない時間。「読み直す」を押したときは無視する */
export const PRS_CACHE_MS = 60_000
/** 一覧に出す 1 リポジトリあたりの件数 */
export const PRS_LIMIT = 50
/** `gh pr diff` の出力をどこまで受けるか。差分の上限（2MB）より大きく取り、切るのは diff.ts の clampPatch() */
export const PR_DIFF_MAX_BYTES = 16 * 1024 * 1024
/** `gh` でログインしている人を覚える時間。引けなかったこと（未ログイン）は短く覚える */
export const VIEWER_CACHE_MS = 10 * 60_000
export const VIEWER_MISS_CACHE_MS = 60_000
/** レビューの投稿を諦めるまで。読むより長く取る（投稿は 1 回きりなので、時間切れで結果が分からなくなるのを避けたい） */
export const REVIEW_POST_TIMEOUT_MS = 30_000

const LIST_FIELDS = 'number,title,author,headRefName,baseRefName,isDraft,updatedAt,url,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,isCrossRepository'
const VIEW_FIELDS = `${LIST_FIELDS},body,state,headRefOid`
/** 会話のコメントとレビュー（#600）。**中身の `gh pr view` とは別に引く**（コメントが大きすぎて上限を超えても、本文と差分は落とさない） */
const COMMENT_FIELDS = 'comments,reviews'
/** コメントの出力をどこまで受けるか。超えたら「読めませんでした」 */
export const PR_COMMENTS_MAX_BYTES = 8 * 1024 * 1024

export interface PrView {
  pr: PrSummary & { body: string; state: string; head_sha: string; cross_repo: boolean }
  /** `gh pr diff` の出力そのもの（切る前）。引けなかった（大きすぎる・時間切れ）なら null */
  patch: string | null
}

/** PR を読む口。テストでは差し替える。引けないは null（例外にしない） */
export interface PrBrowser {
  /** `gh` が使えるか（`SAI_GH=0` なら false）。画面の案内を分けるためだけに使う */
  readonly available: boolean
  list(repo: string, fresh?: boolean): Promise<PrSummary[] | null>
  /**
   * **待たずに**前に引いた一覧を返す（#727。`sai_sessions` の行に PR を足すとき、応答を `gh` に待たせない）。
   * 古ければ裏で引き直す（次に呼ばれたときに新しくなっている）。まだ 1 回も引いていない・`maxAgeMs` より古ければ undefined
   * （何時間も前の CI の状態を「いま」として出さない。呼び出し側は短く待つか、印を付けずに返す）。
   * 無い実装（テストの偽物）は「前の結果は無い」として扱われる
   */
  cached?(repo: string, maxAgeMs?: number): PrSummary[] | null | undefined
  view(repo: string, number: number): Promise<PrView | null>
  /** 会話のコメントとレビュー（#600）。読めなければ null（「無い」の空と分ける）。画面を開いたときと「更新」のときだけ呼ぶ */
  comments(repo: string, number: number): Promise<PrCommentList | null>
  /** 差分の行に付いたコメント（#600 の案 2）。読めなければ null。画面を開いたときと「更新」のときだけ呼ぶ */
  lineComments(repo: string, number: number): Promise<PrLineCommentList | null>
  /** `gh` でログインしている人（#526。投稿の口を出すか・自分の PR か）。未ログイン・引けなければ null */
  viewer(): Promise<string | null>
  /** レビューを投稿する（#526）。投稿できたらそのレビューの URL、できなければ理由 */
  postReview(repo: string, number: number, review: GithubReview): Promise<{ ok: true; url: string } | { ok: false; error: string }>
}

/** 引かない実装（`SAI_GH=0`、テストの既定） */
export class NoPrs implements PrBrowser {
  readonly available = false
  list(): Promise<PrSummary[] | null> {
    return Promise.resolve(null)
  }
  view(): Promise<PrView | null> {
    return Promise.resolve(null)
  }
  comments(): Promise<PrCommentList | null> {
    return Promise.resolve(null)
  }
  lineComments(): Promise<PrLineCommentList | null> {
    return Promise.resolve(null)
  }
  viewer(): Promise<string | null> {
    return Promise.resolve(null)
  }
  postReview(): Promise<{ ok: false; error: string }> {
    return Promise.resolve({ ok: false, error: 'gh を使わない設定です（SAI_GH=0）' })
  }
}

/** `gh` を 1 回走らせる。失敗・時間切れ・上限超えは null。テストは偽物を渡す */
export type GhRun = (args: string[], maxBytes: number) => Promise<string | null>

export function spawnGh(bin: string, timeout = PRS_TIMEOUT_MS): GhRun {
  return (args, maxBytes) =>
    new Promise((resolve) => {
      let child
      try {
        // cwd は触らない（--repo で名指しするので、どこで走らせても同じ答え）
        child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        return resolve(null)
      }
      const chunks: Buffer[] = []
      let size = 0
      let done = false
      const finish = (value: string | null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(null)
      }, timeout)
      child.stdout.on('data', (c: Buffer) => {
        size += c.length
        // 上限を超えたら読むのをやめる（切れた JSON や差分を半端に返さない）
        if (size > maxBytes) {
          child.kill('SIGKILL')
          finish(null)
          return
        }
        chunks.push(c)
      })
      child.once('error', () => finish(null))
      child.once('close', (code) => finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : null))
    })
}

/** `gh` を 1 回走らせ、stdin に `input` を渡して終了コード・stdout・stderr を返す（投稿用。失敗の理由を画面に出すため stderr も取る） */
export type GhSend = (args: string[], input: string) => Promise<{ code: number | null; stdout: string; stderr: string }>

export function spawnGhSend(bin: string, timeout = REVIEW_POST_TIMEOUT_MS): GhSend {
  return (args, input) =>
    new Promise((resolve) => {
      let child
      try {
        child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (err) {
        return resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
      }
      const out: Buffer[] = []
      const err: Buffer[] = []
      let done = false
      const finish = (code: number | null, extra = '') => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') + extra })
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(null, '\n時間切れ（GitHub に載ったかは GitHub で確かめてください）')
      }, timeout)
      child.stdout.on('data', (c: Buffer) => out.length < 1024 && out.push(c))
      child.stderr.on('data', (c: Buffer) => err.length < 256 && err.push(c))
      child.stdin.on('error', () => {})
      child.once('error', (e) => finish(null, e.message))
      child.once('close', (code) => finish(code))
      child.stdin.end(input)
    })
}

interface ListEntry {
  at: number
  prs: PrSummary[] | null
}

export class GhPrs implements PrBrowser {
  readonly available = true
  private readonly run: GhRun
  private readonly ttl: number
  private readonly lists = new Map<string, ListEntry>()
  /** 同じリポジトリの一覧を同時に 2 本引かない（開いた直後の二重の要求など） */
  private readonly inflight = new Map<string, Promise<PrSummary[] | null>>()
  private readonly send: GhSend
  private login: { at: number; value: string | null } | null = null
  private loginJob: Promise<string | null> | null = null

  /** 実行ファイルは既定でサーバの PATH の `gh`（#288）。テストは偽物の run / send を渡す */
  constructor(run: GhRun = spawnGh('gh'), ttl = PRS_CACHE_MS, send: GhSend = spawnGhSend('gh')) {
    this.run = run
    this.ttl = ttl
    this.send = send
  }

  async viewer(): Promise<string | null> {
    const hit = this.login
    if (hit && Date.now() - hit.at < (hit.value ? VIEWER_CACHE_MS : VIEWER_MISS_CACHE_MS)) return hit.value
    if (this.loginJob) return this.loginJob
    this.loginJob = this.run(['api', 'user', '--jq', '.login'], 4096)
      .then((out) => {
        const value = out?.trim() ?? ''
        // ログイン名の形（英数字と -）でなければ引けなかった扱い
        const login = /^[A-Za-z0-9-]{1,39}$/.test(value) ? value : null
        this.login = { at: Date.now(), value: login }
        return login
      })
      .finally(() => {
        this.loginJob = null
      })
    return this.loginJob
  }

  async postReview(repo: string, number: number, review: GithubReview): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    if (!isRepoName(repo) || !isPrNumber(String(number))) return { ok: false, error: '宛先の形が違います' }
    const r = await this.send(['api', '-X', 'POST', `repos/${repo}/pulls/${number}/reviews`, '--input', '-'], JSON.stringify(review))
    if (r.code !== 0) return { ok: false, error: githubErrorText(r.stdout, r.stderr) }
    let url = ''
    try {
      const o = JSON.parse(r.stdout) as { html_url?: unknown }
      if (typeof o.html_url === 'string') url = o.html_url
    } catch {
      // 載ったが応答が読めない。URL 無しで成功として返す
    }
    // レビューの状態（review_decision）が変わるので、一覧は次に引き直す
    this.lists.delete(repo)
    return { ok: true, url }
  }

  cached(repo: string, maxAgeMs = Infinity): PrSummary[] | null | undefined {
    if (!isRepoName(repo)) return null
    const hit = this.lists.get(repo)
    const age = hit ? Date.now() - hit.at : Infinity
    // 古い・まだ無いなら裏で引く（待たない。失敗は list() が null として覚える）
    if (age >= this.ttl) void this.list(repo).catch(() => null)
    return hit && age <= maxAgeMs ? hit.prs : undefined
  }

  async list(repo: string, fresh = false): Promise<PrSummary[] | null> {
    if (!isRepoName(repo)) return null
    const hit = this.lists.get(repo)
    if (!fresh && hit && Date.now() - hit.at < this.ttl) return hit.prs
    const running = this.inflight.get(repo)
    if (running) return running
    const job = this.fetchList(repo).finally(() => this.inflight.delete(repo))
    this.inflight.set(repo, job)
    const prs = await job
    // 引けなかったことも覚える（gh が無いのに開くたびに走らせない）。「読み直す」は fresh で抜ける
    this.lists.set(repo, { at: Date.now(), prs })
    return prs
  }

  private async fetchList(repo: string): Promise<PrSummary[] | null> {
    const [listOut, requestedOut] = await Promise.all([
      this.run(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(PRS_LIMIT), '--json', LIST_FIELDS], 4 * 1024 * 1024),
      // 自分に頼まれているもの（チームに頼まれたものも GitHub の検索が拾う）。引けなくても一覧は出す
      this.run(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(PRS_LIMIT), '--search', 'review-requested:@me', '--json', 'number'], 256 * 1024),
    ])
    const prs = listOut === null ? null : parsePrList(listOut)
    if (!prs) return null
    const requested = requestedOut === null ? new Set<number>() : parseRequested(requestedOut)
    return sortPrs(prs.map((p) => ({ ...p, requested: requested.has(p.number) })))
  }

  async comments(repo: string, number: number): Promise<PrCommentList | null> {
    if (!isRepoName(repo) || !isPrNumber(String(number))) return null
    const out = await this.run(['pr', 'view', String(number), '--repo', repo, '--json', COMMENT_FIELDS], PR_COMMENTS_MAX_BYTES)
    return out === null ? null : parsePrComments(out)
  }

  async lineComments(repo: string, number: number): Promise<PrLineCommentList | null> {
    if (!isRepoName(repo) || !isPrNumber(String(number))) return null
    const out = await this.run(['api', '-X', 'GET', `repos/${repo}/pulls/${number}/comments?per_page=100`, '--paginate', '--jq', LINE_COMMENTS_JQ], PR_COMMENTS_MAX_BYTES)
    return out === null ? null : parsePrLineComments(out)
  }

  async view(repo: string, number: number): Promise<PrView | null> {
    if (!isRepoName(repo) || !isPrNumber(String(number))) return null
    const n = String(number)
    // 1 本の画面は開いたときに取り直す（キャッシュしない。読み直しを押せば最新になる）
    const [viewOut, patch] = await Promise.all([
      this.run(['pr', 'view', n, '--repo', repo, '--json', VIEW_FIELDS], 4 * 1024 * 1024),
      this.run(['pr', 'diff', n, '--repo', repo], PR_DIFF_MAX_BYTES),
    ])
    if (viewOut === null) return null
    let obj: unknown
    try {
      obj = JSON.parse(viewOut)
    } catch {
      return null
    }
    const base = prFromGh(obj)
    if (!base) return null
    const o = obj as Record<string, unknown>
    const requested = this.lists.get(repo)?.prs?.find((p) => p.number === number)?.requested ?? false
    return {
      pr: {
        ...base,
        requested,
        body: typeof o.body === 'string' ? o.body : '',
        state: typeof o.state === 'string' ? o.state : '',
        head_sha: typeof o.headRefOid === 'string' ? o.headRefOid : '',
        // フォークから出た PR（#546 のレビュー）。head のブランチ名は他人のリポジトリのもので、手元のセッションとは関係が無い
        cross_repo: o.isCrossRepository === true,
      },
      // 差分だけ引けない（大きすぎて上限を超えた・時間切れ）ときも、中身の表示は落とさない
      patch,
    }
  }
}

/** 環境変数から PR を読む口を組む。`SAI_GH=0` なら読まない */
export function prBrowserFromEnv(): PrBrowser {
  return process.env.SAI_GH === '0' ? new NoPrs() : new GhPrs()
}
