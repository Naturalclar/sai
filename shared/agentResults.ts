// 成果の確認（#903）。依頼の進捗（#902）のうち、**確かめる成果を返した返答**に「成果確認待ち」を付け、人が「確認済み」にした記録と突き合わせる。
// 確認は SAI の上の記録だけ（`result-checks.json`。CLI の許可・GitHub のレビューの承認・マージ・公開・頼み直しはしない）。
// 確認は**その返答の行に**紐づける（鍵に行の `ts` を入れる）。直してもらった新しい返答は別の鍵なので、前の確認を引き継がない。
// DOM にもプロセスにも触らない純粋関数（サーバが詳細の応答を作るときに呼ぶ。行は舐めない＝呼び出し側が 1 回で引いたものを渡す）
import { localDate } from './entity.ts'
import { isPrNumber, isRepoName } from './prs.ts'
import type { AgentRequest, AgentRequestItem, AgentRequestResult, PrRef } from './types.ts'

/** 1 つの成果に付ける PR の上限（あとに出てきたものを残す） */
export const RESULT_PRS_MAX = 5
/** 直してもらった返答をたどる上限（返信の鎖が長くても回し続けない） */
export const RESULT_CHAIN_MAX = 50

/**
 * 返答が**確かめる成果**を出したか（#903。仮の線。変えるならここ）。PR を名指ししている（GitHub の PR の URL か `PR #N`）か、
 * 画像（スクリーンショット）を出している（`![名前](パス)`）返答だけ。`#N` だけ（issue かもしれない）・進捗の報告・質問は入れない。
 * 未読かどうかは見ない（読んだだけでは確認済みにならない）
 */
export function resultNeedsCheck(text: string): boolean {
  const t = text ?? ''
  return /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+(?![0-9])/i.test(t) || /(?<![A-Za-z0-9_])PR\s?#[0-9]+(?![0-9])/.test(t) || /!\[[^\]\n]*\]\([^)\s]+\)/.test(t)
}

/**
 * 返答に出てきた PR（確かめる先）。GitHub の PR の URL と、`repo`（相手のセッションの GitHub のリモート。空なら読まない）の `PR #N`。
 * `#N` だけのものは読まない（issue の番号を PR として開かない）。あとに出てきた順・重複なし・後ろから `RESULT_PRS_MAX` 件
 */
export function resultPrs(text: string, repo: string): PrRef[] {
  const out: PrRef[] = []
  const bareRepo = isRepoName(repo) ? repo : ''
  const re = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([0-9]+)(?![0-9])|(?<![A-Za-z0-9_])PR\s?#([0-9]+)(?![0-9])/gi
  for (const m of (text ?? '').matchAll(re)) {
    const [, urlRepo = '', urlN = '', bareN = ''] = m
    const ref = urlRepo ? { repo: urlRepo, n: urlN } : { repo: bareRepo, n: bareN }
    if (!ref.repo || !isRepoName(ref.repo) || !isPrNumber(ref.n)) continue
    const key = `${ref.repo.toLowerCase()}#${ref.n}`
    const at = out.findIndex((p) => `${p.repo.toLowerCase()}#${p.number}` === key)
    if (at >= 0) out.splice(at, 1)
    out.push({ repo: ref.repo, number: Number(ref.n) })
  }
  return out.slice(-RESULT_PRS_MAX)
}

/** 確認の記録の鍵（送り元・相手・成果の返答の行の `ts`）。どれも改行を含まない（エンティティ ID と ISO の時刻） */
export function checkKey(from: string, to: string, ts: string): string {
  return `${from}\n${to}\n${ts}`
}

/** 返答の行（成果の候補）。`ts` は送り元の画面に並ぶ返答のバブルと同じ */
export interface ResultRow {
  ts: string
  text: string
  /** どの相手の行か（エンティティ ID）。返答のバブルのまとまり（`sameBubble()`）を見るのに使う。無ければまとまりに数えない */
  to?: string
}

/** 画面が同じ相手の返答を 1 つのバブルにまとめる間（`web/src/chatGroups.ts` の `GROUP_GAP_MIN` と同じ 10 分） */
export const BUBBLE_GAP_MS = 10 * 60_000

/** 画面に並ぶ行 1 つ（バブルのまとまりを見る材料）。`to` が空なのは送り元自身の行 */
interface TimelineRow {
  ms: number
  to: string
}

/**
 * `anchor` の行が、`ts` の行と同じ返答のバブルにまとまっているか（#903 のレビュー）。画面は同じ相手の返答が 10 分より短い間で続き、
 * 間にほかの行（送り元自身の行・別の相手の返答）が無く、日付が変わらなければ 1 つのバブルにまとめ、その下から送った返信の `anchor` は**バブルの最後の行**の `ts` にする
 * （`SessionView` の `sendAcross()`）。`timeline` は古い順。日付は `Asia/Tokyo` で切る（画面はブラウザの時刻帯で切るので、別の時刻帯のブラウザから送った直しはずれうる）
 */
export function sameBubble(timeline: readonly TimelineRow[], to: string, ts: string, anchor: string): boolean {
  const start = Date.parse(ts)
  const end = Date.parse(anchor)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false
  if (end === start) return true
  const day = localDate(new Date(start).toISOString())
  let prev = start
  for (const r of timeline) {
    if (r.ms <= start) continue
    if (r.ms > end) break
    if (r.to !== to || r.ms - prev >= BUBBLE_GAP_MS || localDate(new Date(r.ms).toISOString()) !== day) return false
    prev = r.ms
  }
  return prev === end
}

/** 人が返答のバブルの下から相手へ送った返信（#700）と、相手がそれに返した行（あれば） */
export interface ResultFollowup {
  to: string
  /** どのバブルの下から送ったか（そのバブルの最後の行の `ts`） */
  anchor: string
  reply?: ResultRow
}

/**
 * 依頼の進捗（`agentRequests()` の結果）に、確かめる成果（`result`）を付ける（#903）。
 * - 返答の行（`replies`。message_id → 行）が `resultNeedsCheck()` に当たる依頼だけ。当たらなければ何も付けない
 * - その返答のバブルの下から直しを頼み（`followups`）、相手が返していれば、成果はその新しい返答の行に移る（鎖をたどる。同じバブルの下に
 *   いくつも返っていれば一番新しいもの）。バブルは画面と同じまとめ方で見る（`sameBubble()`。`selfTs` は送り元自身の画面に並ぶ行の時刻で、
 *   まとまりを切る）。新しい返答が PR を名指ししていなければ、前の PR を確かめる先として引き継ぐ（同じ PR に直しを積むので）
 * - 確認済みかは `checkedAt(checkKey(from, to, ts))`。直したあとの返答は鍵が違うので、前の確認は付かない
 * - PR は `repoOf(to)`（相手の GitHub のリモート）で読む。別のリポジトリの相手（`far`）には付けない（#747 の表示の範囲を広げない）
 */
export function attachResults(
  requests: readonly AgentRequest[],
  from: string,
  replies: ReadonlyMap<string, ResultRow>,
  followups: readonly ResultFollowup[],
  checkedAt: (key: string) => string | undefined,
  repoOf: (to: string) => string,
  selfTs: readonly string[] = [],
): AgentRequest[] {
  const answered = followups.filter((f): f is ResultFollowup & { reply: ResultRow } => Boolean(f.reply))
  // 画面に並ぶ行（送り元自身の行・返答の行・直しに返った行）。返答のバブルのまとまりを見るのに使う
  const timeline: TimelineRow[] = [
    ...selfTs.map((ts) => ({ ms: Date.parse(ts), to: '' })),
    ...[...replies.values()].map((r) => ({ ms: Date.parse(r.ts), to: r.to ?? '' })),
    ...answered.map((f) => ({ ms: Date.parse(f.reply.ts), to: f.to })),
  ]
    .filter((r) => Number.isFinite(r.ms))
    .sort((a, b) => a.ms - b.ms)
  // `cur` の行のバブルの下から送った直しに、相手が返した一番新しい行
  const nextOf = (to: string, cur: ResultRow): ResultRow | undefined => {
    let best: ResultRow | undefined
    for (const f of answered) {
      if (f.to !== to || !(Date.parse(f.reply.ts) > Date.parse(cur.ts)) || !sameBubble(timeline, to, cur.ts, f.anchor)) continue
      if (!best || Date.parse(f.reply.ts) > Date.parse(best.ts)) best = f.reply
    }
    return best
  }
  const withResult = (item: AgentRequestItem): AgentRequestItem => {
    const first = item.status === 'done' ? replies.get(item.message_id) : undefined
    if (!first || !resultNeedsCheck(first.text)) return item
    const repo = item.far ? '' : repoOf(item.to)
    let cur = first
    let revised = false
    let prs = item.far ? [] : resultPrs(first.text, repo)
    const seen = new Set([first.ts])
    for (let i = 0; i < RESULT_CHAIN_MAX; i++) {
      const later = nextOf(item.to, cur)
      if (!later || seen.has(later.ts)) break
      seen.add(later.ts)
      cur = later
      revised = true
      const found = item.far ? [] : resultPrs(later.text, repo)
      if (found.length > 0) prs = found
    }
    const checked = checkedAt(checkKey(from, item.to, cur.ts))
    const result: AgentRequestResult = { ts: cur.ts, ...(revised ? { revised: true as const } : {}), ...(checked ? { checked_at: checked } : {}), ...(prs.length > 0 && !item.far ? { prs } : {}) }
    return { ...item, result }
  }
  return requests.map((r) => ({ ...r, items: r.items.map(withResult) }))
}

/** 成果確認待ちの数（確かめる成果があって、まだ確認済みにしていないもの） */
export function uncheckedCount(items: readonly Pick<AgentRequestItem, 'result'>[]): number {
  return items.filter((i) => i.result && !i.result.checked_at).length
}
