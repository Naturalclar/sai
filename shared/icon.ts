// セッションのアイコン画像の受け付け条件。サーバの PUT 受付（server/app.ts）と画面の「画像を選ぶ」
// （web/src/MetaEditor.tsx）が同じ値を見て、選んだ瞬間に弾けるものは送らない。
// 画像そのものは ~/.agent-feed/session-icons/ に置く（server/icons.ts）。session-meta.json には書かない

/** 画像の上限。アバターなので十分 */
export const ICON_MAX_BYTES = 1024 * 1024

export type IconType = 'png' | 'jpeg' | 'gif' | 'webp'

export const ICON_MIME: Record<IconType, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** <input type="file" accept> と、選んだ瞬間の検査に使う */
export const ICON_ACCEPT = Object.values(ICON_MIME).join(',')

/**
 * 先頭のバイト列から画像の種類を決める。Content-Type は信用せず中身で見る（拡張子だけ変えたファイルを画像として置かない）。
 * 分からなければ null
 */
export function sniffImageType(bytes: Uint8Array): IconType | null {
  const at = (i: number) => bytes[i] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'gif'
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'webp'
  return null
}

/**
 * 画面が <img src> に使う URL。サーバが SessionSummary.icon に載せる。
 * version（ファイルの mtime）を付けるので、差し替えれば URL が変わってブラウザのキャッシュを引かない
 */
export function iconUrl(id: string, version: string): string {
  return `/api/sessions/${encodeURIComponent(id)}/icon?v=${encodeURIComponent(version)}`
}
