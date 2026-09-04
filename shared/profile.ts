// 自分（人）の表示名とアイコンの決めごと。サーバ（server/app.ts）と画面（web/src/ProfileEditor.tsx）が同じ値を見る
import { mergeMeta } from './meta.ts'
import type { Profile } from './types.ts'

/**
 * アイコンを IconStore に置くときの鍵。エンティティ ID は `<セッション>@<リポジトリ>` で必ず `@` が入るので衝突しない。
 * ファイル名は iconKey() のハッシュなので、ID からパスを組み立てない決まりもそのまま
 */
export const PROFILE_ICON_ID = 'me'

/** 画面が <img src> に使う URL。version（ファイルの mtime）が変われば URL も変わる */
export function profileIconUrl(version: string): string {
  return `/api/profile/icon?v=${encodeURIComponent(version)}`
}

/**
 * PUT /api/profile の body を検査して、いまの値に重ねる。名前だけ（アイコンは別の口）。
 * 検査（100 文字、空白の正規化、空は消す）はセッションの表示名と同じ mergeMeta を使う
 */
export function mergeProfile(current: Pick<Profile, 'name'>, input: unknown): { name: string | undefined; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { name: undefined, error: 'body はオブジェクトで送ってください' }
  const raw = input as Record<string, unknown>
  const { meta, error } = mergeMeta({ name: current.name }, { name: raw.name })
  return { name: meta.name, error }
}
