// セッションのメタ（ブラウザから付ける表示名・アーカイブ）の検査。アイコン画像は別（shared/icon.ts、server/icons.ts）。
// サーバの PUT 受付（server/app.ts）と画面の入力欄（web/src/MetaEditor.tsx）が同じ関数を使い、ずれない。
import type { SessionMeta } from './types.ts'

export const META_NAME_MAX = 100

/**
 * current に input を重ねて正規化する。input に無いキー（undefined）は据え置き、null / 空文字は「消す」、
 * それ以外は検査して置き換える。知らないキー（昔の絵文字の icon など）は捨てる。error が空でなければ受け付けない。
 * PUT /api/sessions/<id>/meta の意味そのもの。名前を付けるだけ・アーカイブを切り替えるだけ、が互いを消さない
 */
export function mergeMeta(current: SessionMeta, input: unknown): { meta: SessionMeta; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { meta: {}, error: 'body はオブジェクトで送ってください' }
  const raw = input as Record<string, unknown>
  const meta: SessionMeta = { ...current }

  if (raw.name !== undefined) {
    if (raw.name !== null && typeof raw.name !== 'string') return { meta: {}, error: 'name は文字列で送ってください' }
    const name = (raw.name ?? '').replace(/\s+/g, ' ').trim()
    if (name.length > META_NAME_MAX) return { meta: {}, error: `表示名は ${META_NAME_MAX} 文字までです` }
    if (name) meta.name = name
    else delete meta.name
  }

  if (raw.archived_at !== undefined) {
    if (raw.archived_at !== null && typeof raw.archived_at !== 'string') return { meta: {}, error: 'archived_at は時刻の文字列で送ってください' }
    const at = (raw.archived_at ?? '').trim()
    if (at) {
      const ms = Date.parse(at)
      if (Number.isNaN(ms)) return { meta: {}, error: 'archived_at は ISO 形式の時刻で送ってください' }
      meta.archived_at = new Date(ms).toISOString()
    } else {
      delete meta.archived_at
    }
  }

  return { meta, error: '' }
}

/** 何も無い状態に input を重ねる = 入力の検査。画面の入力欄とファイルの読み込みが使う */
export function normalizeMeta(input: unknown): { meta: SessionMeta; error: string } {
  return mergeMeta({}, input)
}

/** 何も付いていないか */
export function isEmptyMeta(meta: SessionMeta | undefined): boolean {
  return !meta || (!meta.name && !meta.archived_at)
}
