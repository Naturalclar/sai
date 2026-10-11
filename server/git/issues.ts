// 「決めること」を拾うために、このリポジトリの issue と PR の文を `gh` で読む（#762）。
//
// - **読むだけ・決め打ちの 3 形だけ**:
//     gh issue list --repo <owner/repo> --state open   --limit <n> --json number,title,body,createdAt,comments
//     gh issue list --repo <owner/repo> --state closed --limit <n> --search closed:>=<日付> --json number,title,body,createdAt,comments
//     gh pr list    --repo <owner/repo> --state open   --limit <n> --json number,title,body,createdAt
//   書く形（`comment` / `edit` / `close` / `api -X POST`）は組まない。`<owner/repo>` は `isRepoName()`、日付は `isDate` の形だけ
// - 認証は `gh` に任せる。`gh` が無い・未ログイン・時間切れ・大きすぎは null
// - `SAI_GH=0` なら引かない（呼ぶ側が `decisionsFromEnv()` で見る）。実行ファイルは PATH の `gh`（#288）
import { isRepoName } from '../../shared/prs.ts'
import { spawnGh } from './prs.ts'
import type { GhRun } from './prs.ts'

/** 1 回の `gh` を諦めるまで（コメントごと引くので、PR の一覧より長く待つ） */
export const ISSUES_TIMEOUT_MS = 60_000
/** open な issue / PR を何件まで引くか */
export const ISSUES_OPEN_LIMIT = 200
/** 閉じた issue を何件まで引くか（届いた数がこれと同じなら、切れているかもしれない） */
export const ISSUES_CLOSED_LIMIT = 300
/** 受ける出力の上限 */
export const ISSUES_MAX_BYTES = 64 * 1024 * 1024

const ISSUE_FIELDS = 'number,title,body,createdAt,comments'
const PR_FIELDS = 'number,title,body,createdAt'
const DATE = /^\d{4}-\d{2}-\d{2}$/

export class GhIssues {
  private readonly run: GhRun
  /** テストは偽物の run を渡す */
  constructor(run: GhRun = spawnGh('gh', ISSUES_TIMEOUT_MS)) {
    this.run = run
  }

  /** open な issue（本文とコメントつき）の JSON。引けなければ null */
  open(repo: string): Promise<string | null> {
    if (!isRepoName(repo)) return Promise.resolve(null)
    return this.run(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(ISSUES_OPEN_LIMIT), '--json', ISSUE_FIELDS], ISSUES_MAX_BYTES)
  }

  /** `since`（`YYYY-MM-DD`）以降に閉じた issue の JSON。引けなければ null */
  closed(repo: string, since: string): Promise<string | null> {
    if (!isRepoName(repo) || !DATE.test(since)) return Promise.resolve(null)
    return this.run(['issue', 'list', '--repo', repo, '--state', 'closed', '--limit', String(ISSUES_CLOSED_LIMIT), '--search', `closed:>=${since}`, '--json', ISSUE_FIELDS], ISSUES_MAX_BYTES)
  }

  /** open な PR（本文つき）の JSON。引けなければ null */
  prs(repo: string): Promise<string | null> {
    if (!isRepoName(repo)) return Promise.resolve(null)
    return this.run(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(ISSUES_OPEN_LIMIT), '--json', PR_FIELDS], ISSUES_MAX_BYTES)
  }
}

/** 環境変数から組む。`SAI_GH=0` なら null（引かない） */
export function issuesFromEnv(): GhIssues | null {
  return process.env.SAI_GH === '0' ? null : new GhIssues()
}
