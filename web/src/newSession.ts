// 新しいセッションを始める画面（#314）の判定。DOM に依存しないので newSession.test.ts を node:test で回す。
// 画面は NewSessionView（選んで送る）と NewSessionStarting（最初の行を待って移る）。
import { isRemoteHost } from '../../shared/host.ts'
import { liveStartDraft } from '../../shared/startDraft.ts'
import type { AddWorktreeResponse, NewSessionRequest, NewSessionResponse, Replying, SessionSummary, SiblingWorktree, StartDraft, StartDraftActionRequest, WorkspacesResponse } from '../../shared/types.ts'

/** 始められる worktree 1 つ */
export interface Workspace {
  /** 画面の中で選んだものを見分ける鍵（記録にある worktree は `from`、兄弟 worktree は `from#worktree`） */
  key: string
  /**
   * サーバに渡す `from`。その cwd で記録された一番新しいセッション（兄弟 worktree は同じリポジトリの一番新しいもの）。
   * **パスは送らない**（サーバがこのセッションの cwd を使う）
   */
  from: string
  /** 記録の無い兄弟 worktree（#319）なら、サーバに渡す鍵。サーバが `git worktree list` を読み直して引き当てる */
  worktree?: string
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
 * エージェントは問わない（Codex で記録された worktree でも、見るのは cwd だけで始めるのは Claude）。
 * `places`（`GET /api/workspaces`。#319）があれば、**git の作業ツリーの中のものだけ**に絞り（`/`・`/tmp`・scratchpad を落とす）、
 * 同じリポジトリの記録の無い worktree を後ろに足す。取れなかった（null）ときは絞らない（サーバが始めるときに断る）
 */
export function workspaceChoices(sessions: readonly SessionSummary[], selfHost: string, places: WorkspacesResponse | null = null): Workspace[] {
  const newest = new Map<string, SessionSummary>()
  for (const s of sessions) {
    if (!s.cwd || isRemoteHost(s.host, selfHost)) continue
    const seen = newest.get(s.cwd)
    if (!seen || Date.parse(s.end) > Date.parse(seen.end)) newest.set(s.cwd, s)
  }
  const git = places ? new Set(places.recorded) : null
  const recorded: Workspace[] = [...newest.values()]
    .filter((s) => !git || git.has(s.id))
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))
    .map((s) => ({ key: s.id, from: s.id, cwd: s.cwd, project: s.project, repo: s.repo, branch: s.branch, end: s.end }))
  const siblings: Workspace[] = (places?.siblings ?? []).map((w) => ({
    key: siblingKey(w),
    from: w.from,
    worktree: w.worktree,
    cwd: w.cwd,
    project: w.project,
    repo: w.repo,
    branch: w.branch,
    end: '',
  }))
  return [...recorded, ...siblings]
}

/** 兄弟 worktree の、画面の中の鍵（`Workspace.key`） */
export const siblingKey = (w: Pick<SiblingWorktree, 'from' | 'worktree'>): string => `${w.from}#${w.worktree}`

/** そのリポジトリに worktree を作れるか（#847）。**新しい画面が古いサーバに当たると `addable` が無い**ので、無ければ出さない */
export const canAddWorktree = (places: Partial<WorkspacesResponse> | null | undefined, from: string): boolean => places?.addable?.includes(from) ?? false

/** 作った worktree（#847）を候補に足す。一覧を取り直さずに、その場で選べるようにする */
export function withSibling(places: WorkspacesResponse, sibling: SiblingWorktree): WorkspacesResponse {
  return { ...places, siblings: [...places.siblings.filter((w) => w.worktree !== sibling.worktree), sibling] }
}

/**
 * 選択肢の見出し（`Naturalclar/sai · dev-worktree-d（main）`）。どのリポジトリか分からなければ worktree 名だけ。
 * 記録の無い兄弟 worktree（#319）には `· 記録なし` を添える（まだそこでエージェントを動かしていない）
 */
export function workspaceLabel(w: Workspace): string {
  const head = w.project ? `${w.project} · ${w.repo}` : w.repo
  const label = w.branch ? `${head}（${w.branch}）` : head
  return w.worktree ? `${label} · 記録なし` : label
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
  if (replying?.failed) return { kind: 'failed', message: `${replying.failed.logged_out ? 'Claude のログインが切れています（画面の上の「SAI からログインする」か、Mac の端末で claude auth login）。' : ''}${replying.failed.tail || `終了コード ${replying.failed.code}`}` }
  if (!replying && now - since > START_SILENT_MS) return { kind: 'silent' }
  return { kind: 'running' }
}

/**
 * 要対応の「開く」から、どの案を開いたかを「新しいセッション」のペインへ渡す置き場（#892）。sessionStorage に置き、ペインが読んだら消す
 * （hash は書き換えない。`<a href="#/new">` を押す前にここへ書く）
 */
export const START_DRAFT_PICK_KEY = 'sai.startDraftPick'

/** 「新しいセッション」のペインに並べる、セッションが置いた案（#892）。置いたセッション = 置き場を決める `from` */
export interface StartDraftChoice {
  from: string
  /** 置いたセッション（呼び名・リポジトリを添えるため） */
  session: SessionSummary
  draft: StartDraft
}

/** 出してよい案（24 時間以内・アーカイブ済みでない・このマシンのもの）を新しい順に */
export function startDraftChoices(sessions: readonly SessionSummary[], selfHost: string, now: number): StartDraftChoice[] {
  const out: StartDraftChoice[] = []
  for (const s of sessions) {
    const draft = liveStartDraft(s.start_draft, now)
    if (!draft || s.archived || isRemoteHost(s.host, selfHost)) continue
    out.push({ from: s.id, session: s, draft })
  }
  return out.sort((a, b) => b.draft.at - a.draft.at)
}

/** 案から始めるのに使う口。画面は `api` をそのまま渡し、テストは偽物を渡す */
export interface StartFromDraftApi {
  addWorktree: (from: string, name: string) => Promise<AddWorktreeResponse>
  startSession: (body: NewSessionRequest) => Promise<NewSessionResponse>
  startDraftAction: (id: string, body: StartDraftActionRequest) => Promise<unknown>
}

export type StartFromDraftResult =
  | { ok: true; res: NewSessionResponse; sibling: SiblingWorktree }
  /** `sibling` があれば worktree はもうできている（押し直すときは作らずにそれで始める） */
  | { ok: false; error: string; sibling?: SiblingWorktree }

/**
 * 案から始める（#892）。**今の画面と同じ 2 つの口を順に通すだけ**: `POST /api/workspaces`（置き場は案を置いたセッションの行の cwd から
 * サーバが組む。名前だけ送る）→ できた worktree の鍵で `POST /api/sessions/new`。始められたら案を片付ける（片付けに失敗しても始めたことは変えない）。
 * worktree を作ったあとで始められなければ、できた worktree を返す（押し直しで 2 つ目を作ろうとして「もうある」で断られないように）
 */
export async function startFromDraft(
  api: StartFromDraftApi,
  plan: { from: string; draft: Pick<StartDraft, 'name' | 'at'>; created: SiblingWorktree | null; body: Omit<NewSessionRequest, 'from' | 'worktree'> },
): Promise<StartFromDraftResult> {
  let sibling = plan.created
  if (!sibling) {
    try {
      sibling = (await api.addWorktree(plan.from, plan.draft.name)).worktree
    } catch (err) {
      return { ok: false, error: `worktree を作れませんでした: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  let res: NewSessionResponse
  try {
    res = await api.startSession({ ...plan.body, from: sibling.from, worktree: sibling.worktree })
  } catch (err) {
    return { ok: false, error: `worktree「${sibling.repo}」は作りました。始められませんでした: ${err instanceof Error ? err.message : String(err)}`, sibling }
  }
  await api.startDraftAction(plan.from, { at: plan.draft.at }).catch(() => undefined)
  return { ok: true, res, sibling }
}
