// そのブランチに出ている GitHub の PR を引く（#211）。差分ボタンに番号を出すためだけに使う。
//
// **ここが SAI で唯一、外のネットワークに問い合わせる場所**なので、次のように閉じてある:
//
// - 叩くのは `gh pr view <branch> --json …` の 1 形だけ。他のサブコマンドは組み立てられない（#636 で reviewDecision、#793 で reviews / headRefOid と、reviews を判定に要る項目だけに絞る --jq を足した）
// - 認証は `gh` に任せる（SAI は鍵を持たない）。`gh` が無い・ログインしていない・PR が無い・
//   ネットワークが死んでいる、のどれでも **null を返すだけ**で、差分そのものの表示は落とさない
// - `SAI_GH=0` で丸ごと切れる。実行ファイルはサーバの PATH の `gh`（#288）
// - cwd はセッションの行から取り、ブランチ名は git から読む。どちらもリクエストからは受けない
import type { DiffPr } from '../../shared/types.ts'
import { PR_VIEW_REVIEWS_JQ, reviewDecisionOf } from '../../shared/prReviewState.ts'
import { spawnGh } from './prs.ts'

/**
 * 引くのを諦めるまで。差分の要約（`?summary=1`）はこれを待たせるので短く（#793 で `reviews` を引くようになり、レビューが
 * 100 件を超える PR では gh が続きを引くぶん往復が増えるが、締切は伸ばさない。間に合わなければ番号が付かないだけ）
 */
export const PR_TIMEOUT_MS = 4000
/** `gh pr view` の出力をどこまで受けるか。超えたら読めなかった扱い（`--jq` で判定に要る件だけに絞るので、ふつうは数 KB） */
export const PR_VIEW_MAX_BYTES = 1024 * 1024
/** 同じ (cwd, ブランチ) を引き直さない時間。PR 番号はそう変わらないが、新しく出した PR は出したい */
export const PR_CACHE_MS = 60_000

/** PR を引く口。テストでは差し替える */
export interface PrLookup {
  /** 見つからない・引けないは null（例外にしない） */
  find(cwd: string, branch: string): Promise<DiffPr | null>
  /** 覚えている分を捨てる（SAI からレビューを投稿したあと。承認の状態が変わるので引き直す。#636 のレビュー）。偽物は持たなくてよい */
  forget?(): void
}

/** 引かない実装（`SAI_GH=0`、テストの既定） */
export class NoPr implements PrLookup {
  find(_cwd: string, _branch: string): Promise<DiffPr | null> {
    return Promise.resolve(null)
  }
}

/**
 * ブランチ名として `gh` に渡してよい形か。フラグに化けるもの（先頭の `-`）と、
 * 空白・引用符の入ったものは断る。シェルは通さないので他は gh に任せる
 */
export function validBranch(branch: string): boolean {
  return branch !== '' && !branch.startsWith('-') && !/[\s'"\\]/.test(branch)
}

/** `gh pr view --json` の出力を DiffPr にする。番号が無ければ null */
export function parsePr(stdout: string): DiffPr | null {
  let obj: unknown
  try {
    obj = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const num = typeof o.number === 'number' ? o.number : 0
  if (!num) return null
  return {
    number: num,
    url: typeof o.url === 'string' ? o.url : '',
    state: typeof o.state === 'string' ? o.state : '',
    draft: o.isDraft === true,
    // reviewDecision が空なら reviews から組む（#793。shared/prReviewState.ts の 1 か所）
    review_decision: reviewDecisionOf(o),
  }
}

interface Entry {
  at: number
  pr: DiffPr | null
}

export class GhPr implements PrLookup {
  readonly bin: string
  private readonly cache = new Map<string, Entry>()

  forget(): void {
    this.cache.clear()
  }
  private readonly ttl: number
  private readonly timeout: number

  /** 実行ファイルは既定でサーバの PATH の `gh`（#288）。テストは偽物を渡す */
  constructor(bin: string = 'gh', ttl = PR_CACHE_MS, timeout = PR_TIMEOUT_MS) {
    this.bin = bin
    this.ttl = ttl
    this.timeout = timeout
  }

  async find(cwd: string, branch: string): Promise<DiffPr | null> {
    if (!cwd || !validBranch(branch)) return null
    const key = `${cwd}\u0000${branch}`
    const hit = this.cache.get(key)
    // 見つからなかった分も覚える（PR の無いブランチで毎回ネットワークに出ない）
    if (hit && Date.now() - hit.at < this.ttl) return hit.pr
    const pr = parsePr(await this.run(cwd, branch))
    this.cache.set(key, { at: Date.now(), pr })
    return pr
  }

  /**
   * 失敗（gh が無い、未ログイン、PR 無し、時間切れ、出力が上限超え）は空文字。例外は投げない。
   * 起こし方は `prs.ts` の `spawnGh()` と同じ 1 つ（締切・上限で子を止める。ここだけ cwd を渡す＝ブランチ名からリポジトリを引く）
   */
  private async run(cwd: string, branch: string): Promise<string> {
    const out = await spawnGh(this.bin, this.timeout, cwd)(['pr', 'view', branch, '--json', 'number,url,state,isDraft,reviewDecision,reviews,headRefOid', '--jq', PR_VIEW_REVIEWS_JQ], PR_VIEW_MAX_BYTES)
    return out ?? ''
  }
}

/** 環境変数から PR を引く口を組む。`SAI_GH=0` なら引かない */
export function prLookupFromEnv(): PrLookup {
  return process.env.SAI_GH === '0' ? new NoPr() : new GhPr()
}
