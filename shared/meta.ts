// セッションのメタ（ブラウザから付ける表示名・アーカイブ・返信のモデル・一言の性格）の検査。アイコン画像は別（shared/icon.ts、server/meta/icons.ts）。
// サーバの PUT 受付（server/app.ts）と画面の入力欄（web/src/MetaEditor.tsx）が同じ関数を使い、ずれない。
import { isPersonaId } from './persona.ts'
import { REPLY_MODES, isReplyPermissionMode } from './permissions.ts'
import type { SessionMeta } from './types.ts'

export const META_NAME_MAX = 100
export const META_MODEL_MAX = 64
/** `continued_from` / `continued_to`（エンティティ ID）の上限 */
export const META_LINK_MAX = 300
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

  if (raw.permission_mode !== undefined) {
    if (raw.permission_mode !== null && typeof raw.permission_mode !== 'string') return { meta: {}, error: 'permission_mode は文字列で送ってください' }
    const mode = (raw.permission_mode ?? '').trim()
    if (mode) {
      // 画面から選べるもの（`REPLY_MODES`）以外はここで弾く。画面に出さないだけでなく、口としても受けない
      if (!isReplyPermissionMode(mode)) return { meta: {}, error: `permission_mode に使えるのは ${REPLY_MODES.join(' / ')} だけです` }
      meta.permission_mode = mode
    } else {
      delete meta.permission_mode
    }
  }

  if (raw.persona !== undefined) {
    if (raw.persona !== null && typeof raw.persona !== 'string') return { meta: {}, error: 'persona は文字列で送ってください' }
    const persona = (raw.persona ?? '').trim()
    if (persona) {
      if (!isPersonaId(persona)) return { meta: {}, error: 'persona が不明です（shared/persona.ts にある id を送ってください）' }
      meta.persona = persona
    } else {
      delete meta.persona
    }
  }

  // 一言を作らない（#263）。**あることが「作らない」**なので、false / null / 空 はどれも「作る」に戻す
  if (raw.digest_off !== undefined) {
    if (raw.digest_off) meta.digest_off = true
    else delete meta.digest_off
  }

  // 引き継ぎの前後（#442）。書くのはサーバ（`POST /api/sessions/new` の `handoff`）だが、ファイルの読み込みもここを通るので受ける。
  // 画面からは消すだけ（リンクを外す）のつもりで、値はエンティティ ID の形までは見ない（リンクにするときに encode する）
  // 分岐元（#405。書くのは `POST /api/sessions/<id>/fork`）も同じ扱い
  for (const key of ['continued_from', 'continued_to', 'forked_from'] as const) {
    if (raw[key] === undefined) continue
    if (raw[key] !== null && typeof raw[key] !== 'string') return { meta: {}, error: `${key} は文字列で送ってください` }
    const value = (raw[key] ?? '').trim()
    if (value.length > META_LINK_MAX) return { meta: {}, error: `${key} が長すぎます` }
    if (value) meta[key] = value
    else delete meta[key]
  }
  if (raw.continued_at !== undefined) {
    if (raw.continued_at !== null && typeof raw.continued_at !== 'string') return { meta: {}, error: 'continued_at は時刻の文字列で送ってください' }
    const at = (raw.continued_at ?? '').trim()
    if (at && Number.isNaN(Date.parse(at))) return { meta: {}, error: 'continued_at は ISO 形式の時刻で送ってください' }
    // 行の `ts` と文字列のまま比べるので、形は変えない
    if (at) meta.continued_at = at
    else delete meta.continued_at
  }

  return { meta, error: '' }
}

/** 何も無い状態に input を重ねる = 入力の検査。画面の入力欄とファイルの読み込みが使う */
export function normalizeMeta(input: unknown): { meta: SessionMeta; error: string } {
  return mergeMeta({}, input)
}

/**
 * アーカイブ済みか。`archived_at >= そのセッションの最後の行の ts`（アーカイブ後に行が増えると、メタを書き換えずに戻る）。
 * サーバの応答と、記録を調べる道具（`server/tools/feedRead.ts`）が同じこの 1 つを見る
 */
export function isArchivedAt(meta: Pick<SessionMeta, 'archived_at'> | undefined, end: string): boolean {
  return !!meta?.archived_at && Date.parse(meta.archived_at) >= Date.parse(end)
}

/** 何も付いていないか */
export function isEmptyMeta(meta: SessionMeta | undefined): boolean {
  return !meta || (!meta.name && !meta.archived_at && !meta.model && !meta.persona && !meta.permission_mode && !meta.digest_off && !meta.continued_from && !meta.forked_from && !meta.continued_to && !meta.continued_at)
}
