// 新しいセッションを始める画面（#314）の判定。DOM に依存しないので newSession.test.ts を node:test で回す。
// 画面は NewSessionView（選んで送る）と NewSessionStarting（最初の行を待って移る）。
import { isRemoteHost } from '../../shared/host.ts'
import type { Replying, SessionSummary } from '../../shared/types.ts'

/** 始められる worktree 1 つ */
export interface Workspace {
  /** サーバに渡す `from`。その cwd で記録された一番新しいセッション。**パスは送らない**（サーバがこのセッションの cwd を使う） */
  from: string
  cwd: string
  project: string
  /** worktree 名（git の toplevel の basename） */
  repo: string
  branch: string
  /** その cwd の一番新しい記録の時刻 */
  end: string
}

/**
 * 一覧から、新しいセッションを始められる worktree を作る。**cwd ごとに 1 つ**（そこで一番新しいセッションを `from` にする）で、
 * 新しい順。別のマシンのものと cwd の分からないものは出さない（サーバも受けない）。
 * エージェントは問わない（Codex で記録された worktree でも、見るのは cwd だけで始めるのは Claude）
 */
export function workspaceChoices(sessions: readonly SessionSummary[], selfHost: string): Workspace[] {
  const newest = new Map<string, SessionSummary>()
  for (const s of sessions) {
    if (!s.cwd || isRemoteHost(s.host, selfHost)) continue
    const seen = newest.get(s.cwd)
    if (!seen || Date.parse(s.end) > Date.parse(seen.end)) newest.set(s.cwd, s)
  }
  return [...newest.values()]
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))
    .map((s) => ({ from: s.id, cwd: s.cwd, project: s.project, repo: s.repo, branch: s.branch, end: s.end }))
}

/** 選択肢の見出し（`Naturalclar/sai · dev-shaka（main）`）。どのリポジトリか分からなければ worktree 名だけ */
export function workspaceLabel(w: Workspace): string {
  const head = w.project ? `${w.project} · ${w.repo}` : w.repo
  return w.branch ? `${head}（${w.branch}）` : head
}

/**
 * CLI が終わったのに最初の行がこれだけ届かなければ、記録が来ていないとみなす（フックの向け先の問題）。
 * 実測では入力の行（UserPromptSubmit）は起動から 1〜2 秒で届く
 */
export const START_SILENT_MS = 30_000

export type StartStatus =
  /** 起動した。最初の行を待っている */
  | { kind: 'running' }
  /** 最初の行が届いた（そのセッションの画面へ移る） */
  | { kind: 'arrived' }
  /** 行を 1 本も書かずに非 0 で終わった（認証切れ・CLI の失敗） */
  | { kind: 'failed'; message: string }
  /** CLI は終わったが行が届かない */
  | { kind: 'silent' }

/**
 * 始めたセッションがいまどうなっているか。`replying` は一覧の `replying[id]`（サーバは一覧に居ないセッションの分も載せるので、
 * 行が届く前の失敗もここに来る）、`since` は送った時刻、`now` は一覧を取った時刻
 */
export function startStatus(arrived: boolean, replying: Replying | undefined, since: number, now: number): StartStatus {
  if (arrived) return { kind: 'arrived' }
  if (replying?.failed) return { kind: 'failed', message: replying.failed.tail || `終了コード ${replying.failed.code}` }
  if (!replying && now - since > START_SILENT_MS) return { kind: 'silent' }
  return { kind: 'running' }
}
