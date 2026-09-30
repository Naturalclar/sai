// GitHub に出ている PR を読む（#524）。一覧・1 本の中身・差分。**読むだけで、GitHub には何も書かない。**
//
// 差分ボタンの PR 番号（pr.ts。#211）と同じ作法で閉じてある:
//
// - 叩くのは下の 4 形だけ（`gh pr list` / `gh pr list --search review-requested:@me` / `gh pr view` / `gh pr diff`）。
//   引数はここで組み立て、任意のサブコマンドは作れない。シェルは通さない
// - リポジトリはサーバが**記録で知っているもの**だけ（shared/prs.ts の knownRepos()。呼び出し側が確かめる）、
//   番号は数字だけ（isPrNumber()）。ここでも形をもう一度確かめる
// - 認証は `gh` に任せる（SAI は鍵を持たない）。`gh` が無い・未ログイン・時間切れは **null を返すだけ**
// - `SAI_GH=0` で丸ごと切れる（NoPrs）。実行ファイルはサーバの PATH の `gh`（#288）
// - チェックアウトも fetch もしない（`RealGit` の「読むだけ」の外に出ない）
import { spawn } from 'node:child_process'
import { isPrNumber, isRepoName, parsePrList, parseRequested, prFromGh, sortPrs } from '../../shared/prs.ts'
import type { PrSummary } from '../../shared/types.ts'

/** 1 回の `gh` を諦めるまで。一覧はリポジトリの数だけ並べて走らせる */
export const PRS_TIMEOUT_MS = 10_000
/** 一覧を引き直さない時間。「読み直す」を押したときは無視する */
export const PRS_CACHE_MS = 60_000
/** 一覧に出す 1 リポジトリあたりの件数 */
export const PRS_LIMIT = 50
/** `gh pr diff` の出力をどこまで受けるか。差分の上限（2MB）より大きく取り、切るのは diff.ts の clampPatch() */
export const PR_DIFF_MAX_BYTES = 16 * 1024 * 1024

const LIST_FIELDS = 'number,title,author,headRefName,baseRefName,isDraft,updatedAt,url,additions,deletions,changedFiles,reviewDecision,statusCheckRollup'
const VIEW_FIELDS = `${LIST_FIELDS},body,state,headRefOid`

export interface PrView {
  pr: PrSummary & { body: string; state: string; head_sha: string }
  /** `gh pr diff` の出力そのもの（切る前）。引けなかった（大きすぎる・時間切れ）なら null */
  patch: string | null
}

/** PR を読む口。テストでは差し替える。引けないは null（例外にしない） */
export interface PrBrowser {
  /** `gh` が使えるか（`SAI_GH=0` なら false）。画面の案内を分けるためだけに使う */
  readonly available: boolean
  list(repo: string, fresh?: boolean): Promise<PrSummary[] | null>
  view(repo: string, number: number): Promise<PrView | null>
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

  /** 実行ファイルは既定でサーバの PATH の `gh`（#288）。テストは偽物の run を渡す */
  constructor(run: GhRun = spawnGh('gh'), ttl = PRS_CACHE_MS) {
    this.run = run
    this.ttl = ttl
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
