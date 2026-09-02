// セッションのメタ（ブラウザから付ける表示名・アイコン・アーカイブ）の検査。
// サーバの PUT 受付（server/app.ts）と画面の入力欄（web/src/MetaEditor.tsx）が同じ関数を使い、ずれない。
import type { SessionMeta } from './types.ts'

export const META_NAME_MAX = 100
/** アイコンは絵文字1つ。ZWJ で繋いだ絵文字（👨‍👩‍👧 など）でもコード単位ではこの程度に収まる */
export const META_ICON_MAX_UNITS = 32

function graphemes(text: string): number {
  if (typeof Intl.Segmenter === 'function') {
    let n = 0
    for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) n++
    return n
  }
  return [...text].length
}

/**
 * current に input を重ねて正規化する。input に無いキー（undefined）は据え置き、null / 空文字は「消す」、
 * それ以外は検査して置き換える。error が空でなければ受け付けない。
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

  if (raw.icon !== undefined) {
    if (raw.icon !== null && typeof raw.icon !== 'string') return { meta: {}, error: 'icon は文字列で送ってください' }
    const icon = (raw.icon ?? '').trim()
    if (icon.length > META_ICON_MAX_UNITS || graphemes(icon) > 1) return { meta: {}, error: 'アイコンは絵文字1つ（1文字）までです' }
    if (icon) meta.icon = icon
    else delete meta.icon
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
  return !meta || (!meta.name && !meta.icon && !meta.archived_at)
}
