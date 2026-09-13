// 一言（digest）への「これは変」（#346）。理由の一覧を、サーバの受付と画面のメニューが同じものを見る。
// 溜め先は ~/.agent-feed/digest-feedback.jsonl（server/digest/feedback.ts）で、外には出さない。

import { entityId } from './entity.ts'

/**
 * 一言の鍵（`<エンティティID>|<行の ts>`）。**サーバ（作る側）と画面（変だと言う側）が同じ関数で作る**。
 * 別々に組み立てると、言われた一言を引けなくなる
 */
export function digestKey(row: { session?: string; repo?: string; ts: string }): string {
  return `${entityId(row.session ?? '', row.repo ?? '', row.ts)}|${row.ts}`
}

export type DigestFeedbackReason = 'meaning' | 'why' | 'next' | 'wrong' | 'long' | 'prefix' | 'tone' | 'other'

/** 画面のメニューの並び。文言は日本語（UI 文言の方針どおり） */
export const DIGEST_FEEDBACK_REASONS: readonly { id: DigestFeedbackReason; label: string }[] = [
  { id: 'meaning', label: '意味が変わった' },
  // 話の筋が落ちた（#359）。溜まったものが、直しが効いたかの物差しになる
  { id: 'why', label: 'なぜそうしたか分からない' },
  { id: 'next', label: '次にすることが分からない' },
  { id: 'wrong', label: '事実が違う' },
  { id: 'long', label: '長い・読みにくい' },
  { id: 'prefix', label: '前置きや引用符が付いた' },
  { id: 'tone', label: '口調が合わない' },
  { id: 'other', label: 'その他' },
]

/** 「こうしてほしい」の上限（文字）。回帰テストの素材にするだけなので長くは要らない */
export const DIGEST_NOTE_MAX = 200

export function isDigestFeedbackReason(value: unknown): value is DigestFeedbackReason {
  return typeof value === 'string' && DIGEST_FEEDBACK_REASONS.some((r) => r.id === value)
}

/** POST /api/digest/feedback の body。一言・モデル・性格はサーバが鍵から引くので送らない */
export interface DigestFeedbackRequest {
  /** 一言の鍵（`<エンティティID>|<行の ts>`）。画面は行の id と ts から組み立てる */
  key: string
  reason: DigestFeedbackReason
  /** 「こうしてほしい」（任意） */
  note?: string
}

export interface DigestFeedbackResponse {
  ok: true
  /** 溜まっている件数（画面の「ありがとう、N 件目」に使う） */
  count: number
}
