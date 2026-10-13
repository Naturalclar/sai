// 画像のメタデータ（EXIF など）を落とす（#791）。
//
// `sips -Z` は EXIF を落とさないので、軽い版（thumbs/）にも元の写真の GPS がそのまま残っていた。添付の原本も同じ。
// `~/.agent-feed` は rsync で別のマシンへ持っていく前提なので、撮った場所が溜まったまま広がる。
//
// Node だけで書く（画像のコーデックは要らない。`shared/icon.ts` が PNG の IHDR を読むのと同じ層）:
// - JPEG: SOI の後のセグメントを順に見て、APP1（EXIF / XMP）・APP13（IPTC）・COM を出力しない。SOS からは画素なのでそのまま。
//   **APP2（ICC プロファイル）は残す**（落とすと Display P3 の写真の色が変わる）。
//   **向き（EXIF の Orientation）だけは残す**: 落とすと縦に撮った写真が横に出る。向き 1 つだけの最小の APP1 を SOI の直後に置く。
// - PNG: `eXIf` / `tEXt` / `zTXt` / `iTXt` のチャンクを出力しない（`iCCP` などは残す）。
// 形が読めない（壊れている）ときは触らずに元のまま返す（壊す方が悪い）。

export type MetadataFormat = 'jpeg' | 'png'

export interface StripResult {
  bytes: Buffer
  /** 何かを落とした（か、向きを置き直した）。false なら bytes は入力そのもの */
  changed: boolean
  /** EXIF の Orientation（1〜8）。無ければ undefined */
  orientation?: number
}

/** 落とす JPEG のセグメント: APP1（EXIF / XMP）・APP13（IPTC）・COM */
const DROP_JPEG = new Set([0xe1, 0xed, 0xfe])
/** 落とす PNG のチャンク */
const DROP_PNG = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt'])

const EXIF_HEAD = Buffer.from('Exif\0\0', 'latin1')

/** 種類に応じて落とす。JPEG / PNG 以外（GIF / WebP）は触らない */
export function stripImageMetadata(bytes: Buffer, format: MetadataFormat | string): StripResult {
  if (format === 'jpeg') return stripJpeg(bytes)
  if (format === 'png') return stripPng(bytes)
  return { bytes, changed: false }
}

/**
 * APP1 の EXIF（TIFF）から Orientation（tag 0x0112）を読む。無い・読めないなら undefined。
 * 見るのは IFD0 だけ（Orientation はそこにある）
 */
export function exifOrientation(payload: Buffer): number | undefined {
  if (payload.length < 14 || !payload.subarray(0, 6).equals(EXIF_HEAD)) return undefined
  const tiff = payload.subarray(6)
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
      if (e + 12 > tiff.length) return undefined
      if (u16(e) === 0x0112 && u16(e + 2) === 3) {
        const v = u16(e + 8)
        return v >= 1 && v <= 8 ? v : undefined
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/** 向きだけを持つ最小の APP1（Exif + TIFF の IFD0 に Orientation 1 つ）。マーカーと長さを含めて 36 バイト */
export function orientationSegment(orientation: number): Buffer {
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
  const payload = Buffer.concat([EXIF_HEAD, tiff])
  const seg = Buffer.alloc(4 + payload.length)
  seg[0] = 0xff
  seg[1] = 0xe1
  seg.writeUInt16BE(payload.length + 2, 2)
  payload.copy(seg, 4)
  return seg
}

function stripJpeg(b: Buffer): StripResult {
  const same = { bytes: b, changed: false }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return same
  const parts: Buffer[] = [b.subarray(0, 2)]
  let orientation: number | undefined
  let dropped = false
  let i = 2
  while (i < b.length) {
    if (b[i] !== 0xff) return same // 形が読めない。触らない
    // マーカーの前の詰め物（FF の連続）
    if (b[i + 1] === 0xff) {
      parts.push(b.subarray(i, i + 1))
      i++
      continue
    }
    const marker = b[i + 1]
    if (marker === undefined) return same
    if (marker === 0xda || marker === 0xd9) {
      parts.push(b.subarray(i)) // SOS からは画素（RST を含む）なのでそのまま。EOI も同じ
      break
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(b.subarray(i, i + 2)) // 長さを持たないマーカー
      i += 2
      continue
    }
    if (i + 4 > b.length) return same
    const len = b.readUInt16BE(i + 2)
    if (len < 2 || i + 2 + len > b.length) return same
    const seg = b.subarray(i, i + 2 + len)
    if (DROP_JPEG.has(marker)) {
      if (marker === 0xe1 && orientation === undefined) orientation = exifOrientation(seg.subarray(4))
      dropped = true
    } else {
      parts.push(seg)
    }
    i += 2 + len
  }
  if (!dropped) return same
  if (orientation !== undefined && orientation !== 1) parts.splice(1, 0, orientationSegment(orientation))
  return { bytes: Buffer.concat(parts), changed: true, ...(orientation !== undefined ? { orientation } : {}) }
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function stripPng(b: Buffer): StripResult {
  const same = { bytes: b, changed: false }
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIG)) return same
  const parts: Buffer[] = [b.subarray(0, 8)]
  let dropped = false
  let i = 8
  while (i + 8 <= b.length) {
    const len = b.readUInt32BE(i)
    const type = b.toString('latin1', i + 4, i + 8)
    const end = i + 12 + len
    if (end > b.length) return same // 壊れている
    const chunk = b.subarray(i, end)
    if (DROP_PNG.has(type)) dropped = true
    else parts.push(chunk)
    i = end
    if (type === 'IEND') break
  }
  if (i < b.length) parts.push(b.subarray(i)) // IEND の後ろに何かあればそのまま
  return dropped ? { bytes: Buffer.concat(parts), changed: true } : same
}
