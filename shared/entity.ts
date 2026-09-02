// エンティティID。一覧・詳細の1エンティティ = 1 (セッション, リポジトリ)。
// 同じセッションIDが別リポジトリに現れても（IDの衝突や cwd の移動）別エンティティとして扱う。
// サーバの集計（server/aggregate.ts）と画面のリンク（web/src/Chat.tsx）が同じ関数を使い、ずれない。

export const TIME_ZONE = 'Asia/Tokyo'

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** ts を Asia/Tokyo の YYYY-MM-DD にする。parse できなければ先頭10文字 */
export function localDate(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts.slice(0, 10) : dateFmt.format(d)
}

/**
 * 1行が属するエンティティのID。`<セッション>@<リポジトリ>`。
 * セッションが空の行は `unknown-<日付>` に丸める（同じリポジトリ・同じ日でひとかたまり）。
 */
export function entityId(session: string, repo: string, ts: string): string {
  const s = session || `unknown-${localDate(ts)}`
  return repo ? `${s}@${repo}` : s
}
