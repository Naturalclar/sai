// GitHub に投稿するレビューの全体のコメントの下書き（#526）。行コメントは #511 / #525 と同じ `sai.diffComments` に PR の鍵で持ち、
// 全体のコメントだけをここ（localStorage の `sai.prReviewBody`）に持つ。DOM に触らない純粋関数（prReviewDraft.test.ts）

/** 覚えておく PR の数の上限（古いものから捨てる） */
export const PR_REVIEW_DRAFTS_MAX = 50

export interface ReviewBodyDraft {
  body: string
  /** 最後に書いた時刻（ms）。上限を超えたら古いものから捨てる */
  at: number
}

/** localStorage の中身を読む。壊れていたら空、形の合わない項目は捨てる */
export function parseReviewBodies(raw: string | null): Record<string, ReviewBodyDraft> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, ReviewBodyDraft> = {}
  for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    if (typeof o.body === 'string' && o.body.trim() !== '' && typeof o.at === 'number') out[key] = { body: o.body, at: o.at }
  }
  return out
}

/** その PR の下書きを置き換えた全体。空なら消し、上限を超えたら古いものから捨てる */
export function withReviewBody(all: Record<string, ReviewBodyDraft>, key: string, body: string, now: number): Record<string, ReviewBodyDraft> {
  const next = { ...all }
  if (body.trim() === '') delete next[key]
  else next[key] = { body, at: now }
  const keys = Object.keys(next).sort((a, b) => (next[b]?.at ?? 0) - (next[a]?.at ?? 0))
  for (const k of keys.slice(PR_REVIEW_DRAFTS_MAX)) delete next[k]
  return next
}
