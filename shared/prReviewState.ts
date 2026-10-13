// PR のレビューの判定を 1 か所で組む（#793）。
//
// GitHub の `reviewDecision` は、ブランチの保護でレビューを必須にしているときだけ値が入る。必須でないリポジトリでは
// 承認があっても空で返るので、SAI の「承認済み」の印が 1 本も出なかった。空のときは `reviews`（レビューの全部）から
// SAI が判定を組む。
//
// `latestReviews` は使わない: gh 2.66 では `latestReviews[].commit.oid` が常に空（`reviews[].commit.oid` には入る。
// 記録で知っているリポジトリで実測）で「承認のあとに更新あり」が出せず、人ごとの最新が COMMENTED（承認した人が
// あとでコメントだけのレビューを返した）になると承認が消える。GitHub 自身の判定は「意見のあるレビュー」
// （APPROVED / CHANGES_REQUESTED）の最新だけを見るので、同じ畳み方をする。
//
// - `reviewDecision` に値があればそのまま（レビュー必須のリポジトリは GitHub の判定に従う。古い承認の扱いもそちら）。
//   知らない値は空（GitHub の判定を SAI が上書きしない）
// - 空のとき: 人ごとに最新の意見のあるレビュー（APPROVED / CHANGES_REQUESTED。DISMISSED は取り消し。COMMENTED は意見を
//   変えない）を取り、数える人（メンバー・オーナー・コラボレーター）のものだけで、CHANGES_REQUESTED が 1 件でもあれば
//   「修正の依頼あり」。無くて APPROVED が 1 件でもあれば「承認済み」。ただし承認した時のコミットが分かっていて今の head と
//   全部違えば「承認のあとに更新あり」（APPROVED_STALE）。コメントだけ・レビュー無し・外部の人やボットの承認だけなら空
// - 承認した時のコミット（`commit.oid`）が無い承認は、同じ PR のほかのレビューにコミットが入っていれば「今の head ではない」
//   （そのコミットが PR から消えた＝force push で書き換えた後）として数え、1 件も入っていなければ（項目の無い古い gh）
//   時刻で代えず「承認済み」のまま
//
// 純粋関数。サーバ（server/git/prs.ts・pr.ts）が `gh` の出力を読むときに通し、画面の 3 か所（一覧の行・PR 1 本の見出し・
// セッションの PR バッジ）は出来上がった `review_decision` を見るだけ（判定を別々に組まない）。
// レビューした人の名前は人ごとに畳むのと、ボット（`isBotLogin()`）を落とすのに使うだけで、ここから外に出さない。
// `gh` には `--jq` で要る項目・要る件だけに絞らせる（本文は読まない。出力の上限にも乗らない）。
// 一覧（`gh pr list`）の `reviews` は先頭 100 件までなので、ちょうど 100 件なら「分からない」として空にする（承認を作らない）。

import { isBotLogin } from './prComments.ts'

/** `review_decision` に入る値。前からの 3 つ + SAI が組む `APPROVED_STALE`。無ければ空 */
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | 'APPROVED_STALE' | ''

/** 数える承認・修正の依頼（`authorAssociation`）。外部の人（CONTRIBUTOR / FIRST_TIME_CONTRIBUTOR / NONE）とボットは数えない */
export const COUNTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['MEMBER', 'OWNER', 'COLLABORATOR'])
/** 意見のあるレビューの `state`（DISMISSED はその人の意見の取り消し）。COMMENTED / PENDING は意見を変えない */
export const OPINIONATED_STATES: ReadonlySet<string> = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'])

const jqIn = (values: ReadonlySet<string>) => `IN(${[...values].map((v) => JSON.stringify(v)).join(', ')})`

/**
 * `gh … --json reviews` の 1 件を、判定に要る項目だけに絞る jq（本文・リアクション・id は読まない）。
 * 判定に関わらないもの（COMMENTED / PENDING、外部の人）は gh の側で落とし、出力の大きさをレビューの数に比例させない。
 * 落とす条件は上の 2 つの Set から組む（プロセスの中の判定と同じ 1 組。`reviewDecisionOf()` は gh を通らない入力も受けるので、
 * 同じ条件でもう一度絞る）
 */
export const REVIEW_ITEM_JQ = `select(.state | ${jqIn(OPINIONATED_STATES)}) | select(.authorAssociation | ${jqIn(COUNTED_ASSOCIATIONS)}) | {state, authorAssociation, submittedAt, author: {login: .author.login}, commit: {oid: .commit.oid}}`
/**
 * `gh pr list` は `reviews` を先頭 100 件までしか取らない（gh 2.66 の一覧の GraphQL は `reviews(first: 100)` で、続きを引かない）。
 * ちょうど 100 件来たら、それより新しいレビューがあるかもしれない＝判定できない。`reviews_page_full` で知らせる
 */
export const GH_LIST_REVIEWS_PAGE = 100
/** `gh pr list --json …,reviews,…` の出力（配列）の `reviews` を絞る。絞る前の数が 1 ページぶんなら `reviews_page_full` を付ける */
export const PR_LIST_REVIEWS_JQ = `[.[] | .reviews_page_full = ((.reviews // []) | length >= ${GH_LIST_REVIEWS_PAGE}) | .reviews = [(.reviews // [])[] | ${REVIEW_ITEM_JQ}]]`
/** `gh pr view --json …,reviews,…` の出力（1 件）の `reviews` を絞る（`pr view` は続きまで引くので、ページの印は付けない） */
export const PR_VIEW_REVIEWS_JQ = `.reviews = [(.reviews // [])[] | ${REVIEW_ITEM_JQ}]`

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** `reviews` の 1 件から、判定に要る分だけ */
export interface Review {
  login: string
  state: string
  association: string
  submittedAt: string
  /** レビューした時のコミット（`commit.oid`）。項目が無い gh では空 */
  commit: string
}

export function reviewsOf(raw: unknown): Review[] {
  if (!Array.isArray(raw)) return []
  const out: Review[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const author = o.author && typeof o.author === 'object' ? (o.author as Record<string, unknown>) : {}
    const commit = o.commit && typeof o.commit === 'object' ? str((o.commit as Record<string, unknown>).oid) : ''
    out.push({ login: str(author.login), state: str(o.state).toUpperCase(), association: str(o.authorAssociation).toUpperCase(), submittedAt: str(o.submittedAt), commit })
  }
  return out
}

/**
 * 人ごとに最新の意見のあるレビュー（APPROVED / CHANGES_REQUESTED）。DISMISSED はその人の意見の取り消し、
 * COMMENTED / PENDING は意見を変えない。順は `submittedAt`（ISO 8601 なので文字の比較でよい。同じなら並び順＝sort は安定）。
 * 名前の無いレビュー（消えたアカウント）は人ごとに畳めないので 1 件ずつ別に数える（鍵は並びの位置。Map の大きさから
 * 作ると、取り消しで縮んだあとに別の 1 件と同じ鍵になる）
 */
export function latestOpinionated(reviews: readonly Review[]): Review[] {
  const sorted = [...reviews].sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0))
  const latest = new Map<string, Review>()
  sorted.forEach((r, i) => {
    if (!OPINIONATED_STATES.has(r.state)) return
    const key = r.login || `#${i}`
    if (r.state === 'DISMISSED') latest.delete(key)
    else latest.set(key, r)
  })
  return [...latest.values()]
}

/**
 * `gh pr list` / `gh pr view` の 1 件（`reviewDecision` / `reviews` / `headRefOid`）から判定。
 * 知らない `reviewDecision` の値は空にする（画面に知らない文字を出さず、GitHub の判定を SAI が上書きしない）
 */
export function reviewDecisionOf(o: { reviewDecision?: unknown; reviews?: unknown; headRefOid?: unknown; reviews_page_full?: unknown }): ReviewDecision {
  const given = str(o.reviewDecision).toUpperCase()
  if (given === 'APPROVED' || given === 'CHANGES_REQUESTED' || given === 'REVIEW_REQUIRED') return given
  if (given) return ''
  if (o.reviews_page_full === true) return '' // 一覧は先頭 100 件まで。続きがあるかもしれないので判定しない
  const reviews = reviewsOf(o.reviews)
  const counted = latestOpinionated(reviews).filter((r) => COUNTED_ASSOCIATIONS.has(r.association) && !isBotLogin(r.login))
  if (counted.some((r) => r.state === 'CHANGES_REQUESTED')) return 'CHANGES_REQUESTED'
  const approvals = counted.filter((r) => r.state === 'APPROVED')
  if (approvals.length === 0) return ''
  const head = str(o.headRefOid)
  // 承認した時のコミットが 1 つでも今の head なら承認済み。全部が head と違えば「承認のあとに更新あり」。
  // コミットの無い承認は、ほかのレビューにコミットが入っていれば（gh が項目を返す）そのコミットが PR から消えたもの＝head ではない。
  // 1 件も入っていなければ項目の無い古い gh なので、時刻で代えず「今の head」として数える（分からないときに承認を疑わない）
  const commitKnown = reviews.some((r) => r.commit !== '')
  const current = approvals.some((r) => !head || (r.commit ? r.commit === head : !commitKnown))
  return current ? 'APPROVED' : 'APPROVED_STALE'
}
