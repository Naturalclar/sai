// 画像のメタデータ（EXIF など）を落とす（#791）。
//
// `sips -Z` は EXIF を落とさないので、軽い版（thumbs/）にも元の写真の GPS がそのまま残っていた。添付の原本も同じ。
// `~/.agent-feed` は rsync で別のマシンへ持っていく前提なので、撮った場所が溜まったまま広がる。
//
// Node だけで書く（画像のコーデックは要らない。`shared/icon.ts` が PNG の IHDR を読むのと同じ層）:
// - JPEG: SOI の後のセグメントを順に見て、残すのは JFIF（APP0）・ICC（APP2 の `ICC_PROFILE`）・Adobe（APP14。CMYK の色変換に要る）だけ。
//   ほかの APPn（APP1 の EXIF / XMP、APP2 の MPF、APP13 の IPTC …）と COM は出力しない。SOS からは画素なのでそのまま。
//   **ICC を残す**のは、落とすと Display P3 の写真の色が変わるため。
//   **向き（EXIF の Orientation）だけは残す**: 落とすと縦に撮った写真が横に出る。向き 1 つだけの最小の APP1 を SOI の直後に置く。
//   **EOI の後ろは落とす**（MPF の副画像・Motion Photo の動画など。副画像の EXIF や動画の位置情報が残るため）。
// - PNG: `eXIf` / `tEXt` / `zTXt` / `iTXt` のチャンクと IEND の後ろを出力しない（`iCCP` などは残す）。`eXIf` に向きがあれば
//   向きだけの `eXIf` を置き直す（ブラウザは PNG の `eXIf` の向きも見る）。
// - WebP: RIFF の `EXIF` / `XMP ` チャンクを出力しない（`ICCP` / `ALPH` / `ANIM` は残す）。VP8X の印も消し、RIFF の長さを直す。
// - GIF: 触らない（EXIF を持たない。コメント拡張は落とさない）。
// 形が読めない（壊れている）ときは触らずに元のまま返す（壊す方が悪い）。
import { crc32 } from 'node:zlib'
import type { IconType } from '../../shared/icon.ts'

export { crc32 }

/**
 * 落とし方の版。変えたら上げる。置き場の印（`STRIPPED_MARK`。前からあるものに一度かけ終えた印）の名前がこれから決まるので、
 * 上げると次の起動でもう一度かかる（軽い版は消して作り直し、添付の原本は落とし直す）
 */
export const METADATA_STRIP_VERSION = 1
/** 置き場（thumbs/・attachments/）に置く「前からあるものにかけ終えた」印のファイル名 */
export const STRIPPED_MARK = `.metadata-stripped-${METADATA_STRIP_VERSION}`

export interface StripResult {
  bytes: Buffer
  /** 何かを落とした（か、向きを置き直した）。false なら bytes は入力そのもの */
  changed: boolean
  /** 形が読めず諦めた（bytes は入力そのもので、メタデータが残っているかもしれない）。「落とす物が無かった」とは別 */
  unreadable?: true
}

const ICC_HEAD = Buffer.from('ICC_PROFILE\0', 'latin1')

/** 残す JPEG のセグメントか。APP0（JFIF）・APP2 の ICC・APP14（Adobe）は残し、ほかの APPn と COM（0xFE）は落とす */
function keepJpegSegment(marker: number, payload: Buffer): boolean {
  if (marker === 0xfe) return false
  if (marker < 0xe0 || marker > 0xef) return true // DQT / SOF / DHT など、画像そのもの
  if (marker === 0xe0 || marker === 0xee) return true
  if (marker === 0xe1) return payload.length === EXIF_HEAD.length + 26 && payload.subarray(0, 6).equals(EXIF_HEAD) && isOrientationOnlyTiff(payload.subarray(6))
  return marker === 0xe2 && payload.subarray(0, ICC_HEAD.length).equals(ICC_HEAD)
}
/** 落とす PNG のチャンク */
const DROP_PNG = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt'])
/** 落とす WebP（RIFF）のチャンク */
const DROP_WEBP = new Set(['EXIF', 'XMP '])

const EXIF_HEAD = Buffer.from('Exif\0\0', 'latin1')
export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 種類に応じて落とす。知らない種類が増えたら、ここで「触らない」と決めるまで型検査が通らない */
export function stripImageMetadata(bytes: Buffer, format: IconType): StripResult {
  switch (format) {
    case 'jpeg':
      return stripJpeg(bytes)
    case 'png':
      return stripPng(bytes)
    case 'webp':
      return stripWebp(bytes)
    case 'gif':
      return { bytes, changed: false }
    default:
      return assertNever(format)
  }
}

function assertNever(format: never): never {
  throw new Error(`知らない画像の種類: ${String(format)}`)
}

/** JPEG のセグメント（マーカー + 長さ（自分を含む）+ 中身）。テストの作り物も同じ形で作る */
export function jpegSegment(marker: number, payload: Buffer): Buffer {
  const seg = Buffer.alloc(4 + payload.length)
  seg[0] = 0xff
  seg[1] = marker
  seg.writeUInt16BE(payload.length + 2, 2)
  payload.copy(seg, 4)
  return seg
}

/** APP1 の EXIF（`Exif\0\0` + TIFF）から Orientation。無い・読めないなら undefined */
export function exifOrientation(payload: Buffer): number | undefined {
  if (payload.length < 14 || !payload.subarray(0, 6).equals(EXIF_HEAD)) return undefined
  return tiffOrientation(payload.subarray(6))
}

/**
 * TIFF から Orientation（tag 0x0112。SHORT か LONG）を読む。無い・読めないなら undefined。
 * 見るのは IFD0 だけ（Orientation はそこにある）。PNG の `eXIf` の中身も同じ形
 */
export function tiffOrientation(tiff: Buffer): number | undefined {
  if (tiff.length < 8) return undefined
  const order = tiff.toString('latin1', 0, 2)
  const le = order === 'II'
  if (!le && order !== 'MM') return undefined
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o))
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o))
  try {
    if (u16(2) !== 42) return undefined
    const ifd = u32(4)
    const count = u16(ifd)
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12
      if (u16(e) !== 0x0112) continue
      const type = u16(e + 2)
      // 値は 4 バイトの欄の先頭に入る（SHORT は 2 バイト、LONG は 4 バイト。書き手によってどちらもある）
      const v = type === 3 ? u16(e + 8) : type === 4 ? u32(e + 8) : 0
      return v >= 1 && v <= 8 ? v : undefined
    }
  } catch {
    return undefined // 欄がファイルの外を指す（Buffer の読みが RangeError）
  }
  return undefined
}

/** 向きだけを持つ最小の TIFF（IFD0 に Orientation 1 つ。26 バイト） */
export function orientationTiff(orientation: number): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write('II', 0, 'latin1')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4) // IFD0 は見出しの直後
  tiff.writeUInt16LE(1, 8) // エントリ 1 つ
  tiff.writeUInt16LE(0x0112, 10)
  tiff.writeUInt16LE(3, 12) // SHORT
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt16LE(orientation, 18)
  tiff.writeUInt32LE(0, 22) // 次の IFD は無い
  return tiff
}

/** 向きだけを持つ最小の APP1。マーカーと長さを含めて 36 バイト */
export function orientationSegment(orientation: number): Buffer {
  return jpegSegment(0xe1, Buffer.concat([EXIF_HEAD, orientationTiff(orientation)]))
}

/**
 * この関数が置いた「向きだけの TIFF」そのものか（26 バイトで、中身が orientationTiff と同じ）。
 * 同じなら落として置き直さない（2 回目に通しても「変わった」にならない＝置き場を毎回書き直さない）
 */
function isOrientationOnlyTiff(tiff: Buffer): boolean {
  if (tiff.length !== 26) return false
  const o = tiffOrientation(tiff)
  return o !== undefined && tiff.equals(orientationTiff(o))
}

/** PNG のチャンク（長さ + 種類 + 中身 + CRC）。テストの作り物も同じ形で作る */
export function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length)
  return out
}


/**
 * SOS の見出しの後ろから EOI（FFD9）の次の位置を探す。画素（エントロピー符号）の中の FF は FF00 の詰め物か RST（FFD0〜D7）
 * なので飛ばし、それ以外のマーカー（プログレッシブの DQT / DHT / 次の SOS など）は長さぶん飛ばす（セグメントの中身に FFD9 が
 * あっても EOI と取り違えない）。見つからなければ末尾
 */
function eoiAfter(b: Buffer, from: number): number {
  let i = from
  while (i + 1 < b.length) {
    i = b.indexOf(0xff, i) // 次の FF まで飛ぶ（1 バイトずつの JS のループにしない。10MB の原本を配るたびに通る）
    if (i < 0 || i + 1 >= b.length) return b.length
    const m = b[i + 1]!
    if (m === 0x00 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) {
      i += m === 0xff ? 1 : 2
      continue
    }
    if (m === 0xd9) return i + 2
    if (i + 4 > b.length) return b.length
    i += 2 + b.readUInt16BE(i + 2) // 長さを持つセグメント（SOS なら見出しの後ろから画素が続く）
  }
  return b.length
}

function stripJpeg(b: Buffer): StripResult {
  const same: StripResult = { bytes: b, changed: false }
  const unreadable: StripResult = { bytes: b, changed: false, unreadable: true }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return unreadable
  const parts: Buffer[] = [b.subarray(0, 2)]
  let orientation: number | undefined
  let changed = false
  let i = 2
  while (i < b.length) {
    if (b[i] !== 0xff) return unreadable // 形が読めない。触らない
    // マーカーの前の詰め物（FF の連続）
    if (b[i + 1] === 0xff) {
      parts.push(b.subarray(i, i + 1))
      i++
      continue
    }
    const marker = b[i + 1]
    if (marker === undefined) return unreadable
    if (marker === 0xda || marker === 0xd9) {
      // SOS からは画素（RST を含む）なので EOI までそのまま。EOI の後ろ（MPF の副画像・Motion Photo の動画）は落とす
      let end = i + 2
      if (marker === 0xda) {
        if (i + 4 > b.length) return unreadable
        end = eoiAfter(b, i + 2 + b.readUInt16BE(i + 2))
      }
      parts.push(b.subarray(i, end))
      if (end < b.length) changed = true
      break
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(b.subarray(i, i + 2)) // 長さを持たないマーカー
      i += 2
      continue
    }
    if (i + 4 > b.length) return unreadable
    const len = b.readUInt16BE(i + 2)
    if (len < 2 || i + 2 + len > b.length) return unreadable
    const seg = b.subarray(i, i + 2 + len)
    if (keepJpegSegment(marker, seg.subarray(4))) {
      parts.push(seg)
      if (marker === 0xe1 && orientation === undefined) orientation = 1 // 向きだけの APP1 はもう置いてある。入れ直さない
    } else {
      if (marker === 0xe1 && orientation === undefined) orientation = exifOrientation(seg.subarray(4))
      changed = true
    }
    i += 2 + len
  }
  if (!changed) return same
  if (orientation !== undefined && orientation !== 1) parts.splice(1, 0, orientationSegment(orientation))
  return { bytes: Buffer.concat(parts), changed: true }
}

function stripPng(b: Buffer): StripResult {
  const same: StripResult = { bytes: b, changed: false }
  const unreadable: StripResult = { bytes: b, changed: false, unreadable: true }
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIG)) return unreadable
  const parts: Buffer[] = [b.subarray(0, 8)]
  let changed = false
  let orientation: number | undefined
  let ended = false
  let i = 8
  while (i + 8 <= b.length) {
    const len = b.readUInt32BE(i)
    const type = b.toString('latin1', i + 4, i + 8)
    const end = i + 12 + len
    if (end > b.length) return unreadable // 壊れている
    const data = b.subarray(i + 8, i + 8 + len)
    if (type === 'eXIf' && isOrientationOnlyTiff(data)) {
      parts.push(b.subarray(i, end)) // 自分で置いた向きだけの eXIf。落として置き直さない
      if (orientation === undefined) orientation = 1
    } else if (DROP_PNG.has(type)) {
      if (type === 'eXIf' && orientation === undefined) orientation = tiffOrientation(data)
      changed = true
    } else {
      parts.push(b.subarray(i, end))
    }
    i = end
    if (type === 'IEND') {
      ended = true
      break
    }
  }
  // IEND の後ろは落とす。IEND が無い（壊れた・作り物）なら残りはそのまま
  if (i < b.length) {
    if (ended) changed = true
    else parts.push(b.subarray(i))
  }
  if (!changed) return same
  // 向きだけの eXIf を IHDR の直後に置き直す（ブラウザは PNG の eXIf の向きも見る）
  if (orientation !== undefined && orientation !== 1 && parts.length > 1) parts.splice(2, 0, pngChunk('eXIf', orientationTiff(orientation)))
  return { bytes: Buffer.concat(parts), changed: true }
}

/** WebP（RIFF）。`RIFF` + 長さ + `WEBP` + チャンク（fourcc + 長さ LE + 中身 + 偶数詰め） */
function stripWebp(b: Buffer): StripResult {
  const same: StripResult = { bytes: b, changed: false }
  const unreadable: StripResult = { bytes: b, changed: false, unreadable: true }
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return unreadable
  const chunks: Buffer[] = []
  let changed = false
  let i = 12
  while (i + 8 <= b.length) {
    const fourcc = b.toString('latin1', i, i + 4)
    const len = b.readUInt32LE(i + 4)
    const end = i + 8 + len + (len % 2)
    if (i + 8 + len > b.length) return unreadable // 壊れている
    if (DROP_WEBP.has(fourcc)) changed = true
    else chunks.push(b.subarray(i, Math.min(end, b.length)))
    i = end
  }
  if (!changed) return same
  // VP8X の印（EXIF = 0x08、XMP = 0x04）を消す
  const first = chunks[0]
  if (first && first.toString('latin1', 0, 4) === 'VP8X' && first.length >= 9) {
    const copy = Buffer.from(first)
    copy[8] = (copy[8] ?? 0) & ~0x0c
    chunks[0] = copy
  }
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(4 + body.length, 4)
  head.write('WEBP', 8, 'latin1')
  return { bytes: Buffer.concat([head, body]), changed: true }
}
