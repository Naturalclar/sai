// セッションのメタ（ブラウザから付ける表示名・アーカイブ）の検査。アイコン画像は別（shared/icon.ts、server/icons.ts）。
// サーバの PUT 受付（server/app.ts）と画面の入力欄（web/src/MetaEditor.tsx）が同じ関数を使い、ずれない。
import type { SessionMeta } from './types.ts'

export const META_NAME_MAX = 100
export const META_MODEL_MAX = 64
/**
 * モデル名・別名に使える文字。`claude-opus-5`、`opus`、`gpt-5.6-sol`、設定の `fable[1m]` のような形。
 * 先頭は英数字（`-` で始まると CLI の引数に化ける）
 */
export const META_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/

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

  if (raw.model !== undefined) {
    if (raw.model !== null && typeof raw.model !== 'string') return { meta: {}, error: 'model は文字列で送ってください' }
    const model = (raw.model ?? '').trim()
    if (model.length > META_MODEL_MAX) return { meta: {}, error: `モデル名は ${META_MODEL_MAX} 文字までです` }
    if (model && !META_MODEL_RE.test(model)) return { meta: {}, error: 'モデル名は英数字で始め、使えるのは英数字と . _ : / - [ ] です' }
    if (model) meta.model = model
    else delete meta.model
  }

  return { meta, error: '' }
}

/** 何も無い状態に input を重ねる = 入力の検査。画面の入力欄とファイルの読み込みが使う */
export function normalizeMeta(input: unknown): { meta: SessionMeta; error: string } {
  return mergeMeta({}, input)
}

/** 何も付いていないか */
export function isEmptyMeta(meta: SessionMeta | undefined): boolean {
  return !meta || (!meta.name && !meta.archived_at && !meta.model)
}
