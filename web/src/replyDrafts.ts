// 入力欄の打ちかけ（本文と画像）をセッションごとに残す（#306）。
// 画面を移ると ReplyBox ごと外れて state が消えるので、localStorage の `sai.drafts` に置く。
// メモリに持たないのは、携帯（tailscale serve 経由の iPhone）では裏に回したタブを Safari が捨てて
// 読み直すことがよくあり、アプリを切り替えて戻っただけで消えてしまうため。
// 規則（空なら消す・古いもの／多すぎるものを捨てる・壊れていたら空）は純粋関数にして replyDrafts.test.ts で回す。
// localStorage に触るのは下の loadDraft / saveDraft だけ。
import type { Attached } from './useAttachments'

export const DRAFTS_KEY = 'sai.drafts'
/** これより古い下書きは、次に書くときに捨てる */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** 残す数の上限（新しい順）。セッションを渡り歩いても溜まり続けない */
export const DRAFT_MAX_COUNT = 50

export interface Draft {
  text: string
  /** 預けた画像。置き場のファイルは消えない（server/reply/attachments.ts に削除が無い）ので、戻せばサムネイルも出る */
  attachments: Attached[]
}

interface Stored extends Draft {
  /** 最後に書いた時刻（ms） */
  at: number
}

/** エンティティ ID → 下書き */
export type Drafts = Record<string, Stored>

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

const has = (drafts: Drafts, id: string) => Object.prototype.hasOwnProperty.call(drafts, id)

/** 本文が空白だけで画像も無い。残す意味が無いので消す */
export const isEmptyDraft = (d: Draft): boolean => d.text.trim() === '' && d.attachments.length === 0

const isAttached = (a: unknown): a is Attached =>
  !!a && typeof a === 'object' && typeof (a as Attached).path === 'string' && typeof (a as Attached).url === 'string'

/**
 * localStorage の文字列を読む。壊れた JSON・形の違う値は空として読む（useLocalState と同じく落とさない）。
 * 組み立ては Object.fromEntries（`__proto__` という鍵が来ても代入にならない）
 */
export function parseDrafts(raw: string | null): Drafts {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const entries: [string, Stored][] = []
  for (const [id, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object') continue
    const { text, attachments, at } = value as Record<string, unknown>
    if (typeof text !== 'string' || typeof at !== 'number' || !Array.isArray(attachments)) continue
    entries.push([id, { text, attachments: attachments.filter(isAttached).map(({ path, url }) => ({ path, url })), at }])
  }
  return Object.fromEntries(entries)
}

/** その返信先の下書き。無ければ空 */
export function draftOf(drafts: Drafts, id: string): Draft {
  const d = has(drafts, id) ? drafts[id] : undefined
  return d ? { text: d.text, attachments: d.attachments } : EMPTY_DRAFT
}

/**
 * 下書きを書いた後の全体。空なら消す。ついでに DRAFT_MAX_AGE_MS より古いものを捨て、
 * 新しい順に DRAFT_MAX_COUNT 件までにする
 */
export function withDraft(drafts: Drafts, id: string, draft: Draft, now: number): Drafts {
  const rest = Object.entries(drafts).filter(([key, d]) => key !== id && now - d.at <= DRAFT_MAX_AGE_MS)
  const next: [string, Stored][] = isEmptyDraft(draft) ? rest : [[id, { text: draft.text, attachments: draft.attachments, at: now }], ...rest]
  next.sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(next.slice(0, DRAFT_MAX_COUNT))
}

/** 入力欄を作るときに読む。localStorage が使えなければ空 */
export function loadDraft(id: string): Draft {
  try {
    return draftOf(parseDrafts(localStorage.getItem(DRAFTS_KEY)), id)
  } catch {
    return EMPTY_DRAFT
  }
}

/** 本文か画像が変わるたびに書く。空で、もともと無ければ何もしない */
export function saveDraft(id: string, draft: Draft, now: number = Date.now()): void {
  try {
    const drafts = parseDrafts(localStorage.getItem(DRAFTS_KEY))
    if (isEmptyDraft(draft) && !has(drafts, id)) return
    const next = withDraft(drafts, id, draft, now)
    if (Object.keys(next).length === 0) localStorage.removeItem(DRAFTS_KEY)
    else localStorage.setItem(DRAFTS_KEY, JSON.stringify(next))
  } catch {
    // 保存できなくても入力欄は動く（容量オーバー・プライベートブラウズ）
  }
}
