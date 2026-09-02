// セッションの表示名・アイコン（ブラウザから付けるもの）の検査。
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
 * 入力を正規化して返す。error が空でなければ受け付けない。
 * name / icon は前後の空白を落とし、空になったら「消す」の意味でキーごと落とす。
 */
export function normalizeMeta(input: unknown): { meta: SessionMeta; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { meta: {}, error: 'body はオブジェクトで送ってください' }
  const raw = input as Record<string, unknown>
  const meta: SessionMeta = {}

  if (raw.name !== undefined && raw.name !== null) {
    if (typeof raw.name !== 'string') return { meta: {}, error: 'name は文字列で送ってください' }
    const name = raw.name.replace(/\s+/g, ' ').trim()
    if (name.length > META_NAME_MAX) return { meta: {}, error: `表示名は ${META_NAME_MAX} 文字までです` }
    if (name) meta.name = name
  }

  if (raw.icon !== undefined && raw.icon !== null) {
    if (typeof raw.icon !== 'string') return { meta: {}, error: 'icon は文字列で送ってください' }
    const icon = raw.icon.trim()
    if (icon.length > META_ICON_MAX_UNITS || graphemes(icon) > 1) return { meta: {}, error: 'アイコンは絵文字1つ（1文字）までです' }
    if (icon) meta.icon = icon
  }

  return { meta, error: '' }
}

/** 何も付いていないか */
export function isEmptyMeta(meta: SessionMeta | undefined): boolean {
  return !meta || (!meta.name && !meta.icon)
}
