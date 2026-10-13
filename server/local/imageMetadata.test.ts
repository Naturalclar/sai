// 画像のメタデータを落とす（#791）。作り物の JPEG / PNG / WebP で、落とすもの（EXIF / XMP / MPF / IPTC / COM・EOI の後ろ、
// PNG の文字と eXIf のチャンク、WebP の EXIF / XMP）と残すもの（JFIF・ICC・Adobe・画素・向き）を見る。
// 本物の写真での確認（magick identify で exif: が 0 件・ICC が残る）は PR に書く。
// ここの作り物（jpeg() / JPEG_WITH_EXIF など）は thumbnails / attachments / icons のテストも使う
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crc32, exifOrientation, jpegSegment, orientationSegment, orientationTiff, PNG_SIG, pngChunk, stripImageMetadata, tiffOrientation } from './imageMetadata.ts'
import { imageSize } from './thumbnails.ts'

export const seg = jpegSegment
/** EXIF（TIFF）。IFD0 に Orientation（type は SHORT か LONG）と GPS IFD へのポインタ */
export const exif = (orientation: number, order: 'II' | 'MM' = 'MM', orientationType: 3 | 4 = 3) => {
  const le = order === 'II'
  const t = Buffer.alloc(8 + 2 + 12 * 2 + 4 + 2 + 12 + 4)
  t.write(order, 0, 'latin1')
  const w16 = (v: number, o: number) => (le ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o))
  const w32 = (v: number, o: number) => (le ? t.writeUInt32LE(v, o) : t.writeUInt32BE(v, o))
  w16(42, 2)
  w32(8, 4)
  w16(2, 8)
  // Orientation
  w16(0x0112, 10)
  w16(orientationType, 12)
  w32(1, 14)
  if (orientationType === 3) w16(orientation, 18)
  else w32(orientation, 18)
  // GPS IFD ポインタ
  w16(0x8825, 22)
  w16(4, 24)
  w32(1, 26)
  w32(38, 30)
  w32(0, 34)
  // GPS IFD: GPSLatitudeRef 1 つ
  w16(1, 38)
  w16(0x0001, 40)
  w16(2, 42)
  w32(2, 44)
  t.write('N\0', 48, 'latin1')
  w32(0, 50)
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t])
}
export const SOI = Buffer.from([0xff, 0xd8])
export const APP0 = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'))
export const ICC = seg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'), Buffer.alloc(40, 7)]))
export const MPF = seg(0xe2, Buffer.from('MPF\0MM\0\x2a\0\0\0\x08', 'latin1'))
export const ADOBE = seg(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\0\x01', 'latin1'))
export const XMP = seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPS</x:xmpmeta>', 'latin1'))
export const IPTC = seg(0xed, Buffer.from('Photoshop 3.0\0' + '8BIM'.padEnd(20, '\0'), 'latin1'))
export const COM = seg(0xfe, Buffer.from('a comment', 'latin1'))
export const DQT = seg(0xdb, Buffer.alloc(65, 1))
/** SOF0: 高さ 384・幅 512 */
export const SOF = seg(0xc0, Buffer.from([8, 1, 128, 2, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]))
/** SOS 以降（画素。RST と FF00 の詰め物を含む）と EOI */
export const TAIL = Buffer.concat([seg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0])), Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9])])
export const jpeg = (...middle: Buffer[]) => Buffer.concat([SOI, ...middle, TAIL])
/** GPS 入りの EXIF が付いた JPEG と、落とした後の形（thumbnails / attachments / icons のテストが使う） */
export const JPEG_WITH_EXIF = jpeg(seg(0xe1, exif(1)), APP0, DQT, SOF)
export const JPEG_STRIPPED = jpeg(APP0, DQT, SOF)

test('JPEG: EXIF / XMP / MPF / IPTC / COM を落とし、JFIF・ICC・Adobe・DQT・SOF・画素は残す。向き 1 なら APP1 は残らない', () => {
  const src = jpeg(APP0, seg(0xe1, exif(1)), ICC, MPF, XMP, IPTC, ADOBE, COM, DQT, SOF)
  const r = stripImageMetadata(src, 'jpeg')
  assert.equal(r.changed, true)
  assert.deepEqual(r.bytes, jpeg(APP0, ICC, ADOBE, DQT, SOF), '残るものは順番もそのまま')
  assert.deepEqual(imageSize(r.bytes, 'jpeg'), { width: 512, height: 384 })
  assert.equal(r.bytes.indexOf('GPS'), -1)
  assert.deepEqual(stripImageMetadata(JPEG_WITH_EXIF, 'jpeg').bytes, JPEG_STRIPPED)
})

test('JPEG: 向きが 1 以外なら、向きだけの最小の APP1 を SOI の直後に置く（GPS は残らない）。SHORT でも LONG でも', () => {
  for (const order of ['MM', 'II'] as const) {
    for (const type of [3, 4] as const) {
      const r = stripImageMetadata(jpeg(APP0, seg(0xe1, exif(6, order, type)), ICC, DQT, SOF), 'jpeg')
      assert.deepEqual(r.bytes, jpeg(orientationSegment(6), APP0, ICC, DQT, SOF), `${order} type=${type}`)
    }
  }
  assert.equal(exifOrientation(orientationSegment(6).subarray(4)), 6, '置いた APP1 を読み返すと 6')
  assert.equal(orientationSegment(6).length, 36)
})

test('JPEG: EOI の後ろ（MPF の副画像・Motion Photo の動画）は落とす', () => {
  const trailer = Buffer.concat([jpeg(seg(0xe1, exif(1)), DQT, SOF), Buffer.from('ftypmp42...GPSTRAILER', 'latin1')])
  const src = Buffer.concat([jpeg(APP0, DQT, SOF), trailer])
  const r = stripImageMetadata(src, 'jpeg')
  assert.equal(r.changed, true)
  assert.deepEqual(r.bytes, jpeg(APP0, DQT, SOF))
  assert.equal(r.bytes.indexOf('GPS'), -1)
})

test('JPEG: 落とすものが無ければ入力そのもの。壊れていれば触らない', () => {
  const clean = jpeg(APP0, ICC, DQT, SOF)
  const r = stripImageMetadata(clean, 'jpeg')
  assert.equal(r.changed, false)
  assert.equal(r.bytes, clean, '同じ Buffer')
  // セグメントの長さがファイルの外を指す（読めなかった、の信号が付く。落とす物が無かった clean には付かない）
  const broken = Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0xff, 0xff, 1, 2])])
  assert.equal(stripImageMetadata(broken, 'jpeg').bytes, broken)
  assert.equal(stripImageMetadata(broken, 'jpeg').unreadable, true)
  assert.equal(r.unreadable, undefined)
  // SOI の後にマーカーでないバイト
  const junk = Buffer.concat([SOI, Buffer.from([0x00, 0xe1, 0, 4, 1, 2])])
  assert.equal(stripImageMetadata(junk, 'jpeg').bytes, junk)
  assert.equal(stripImageMetadata(Buffer.from([0xff]), 'jpeg').changed, false)
})

test('JPEG: マーカーの前の FF の詰め物と、長さを持たないマーカーをまたいでも落とせる', () => {
  const src = Buffer.concat([SOI, Buffer.from([0xff]), APP0, Buffer.from([0xff, 0x01]), COM, DQT, SOF, TAIL])
  const r = stripImageMetadata(src, 'jpeg')
  assert.deepEqual(r.bytes, Buffer.concat([SOI, Buffer.from([0xff]), APP0, Buffer.from([0xff, 0x01]), DQT, SOF, TAIL]))
})

test('exifOrientation / tiffOrientation: 形が違えば undefined', () => {
  assert.equal(exifOrientation(Buffer.from('nope')), undefined)
  assert.equal(exifOrientation(Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('XX\0\x2a\0\0\0\x08')])), undefined)
  assert.equal(exifOrientation(exif(9)), undefined, '1〜8 の外')
  assert.equal(tiffOrientation(Buffer.from('MM\0\x2a\0\0\xff\xff', 'latin1')), undefined, 'IFD がファイルの外')
  assert.equal(tiffOrientation(orientationTiff(3)), 3)
})

export const IHDR = pngChunk('IHDR', Buffer.from([0, 0, 2, 0, 0, 0, 1, 0x80, 8, 2, 0, 0, 0]))
export const ICCP = pngChunk('iCCP', Buffer.from('Display P3\0\0abc', 'latin1'))
export const IDAT = pngChunk('IDAT', Buffer.alloc(16, 9))
export const IEND = pngChunk('IEND', Buffer.alloc(0))
export const PNG_WITH_TEXT = Buffer.concat([PNG_SIG, IHDR, ICCP, pngChunk('tEXt', Buffer.from('Comment\0made by', 'latin1')), pngChunk('eXIf', Buffer.from('MM\0\x2aGPS', 'latin1')), IDAT, IEND])
export const PNG_STRIPPED = Buffer.concat([PNG_SIG, IHDR, ICCP, IDAT, IEND])

test('PNG: eXIf / tEXt / zTXt / iTXt と IEND の後ろを落とし、iCCP・IHDR・IDAT は残す。CRC は zlib と同じ', () => {
  const src = Buffer.concat([PNG_WITH_TEXT.subarray(0, PNG_WITH_TEXT.length - IEND.length), pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x/>', 'latin1')), pngChunk('zTXt', Buffer.alloc(8)), IEND, Buffer.from('trailer')])
  const r = stripImageMetadata(src, 'png')
  assert.equal(r.changed, true)
  assert.deepEqual(r.bytes, PNG_STRIPPED)
  assert.deepEqual(imageSize(r.bytes, 'png'), { width: 512, height: 384 })
  assert.equal(crc32(Buffer.from('IEND', 'latin1')), 0xae426082, 'IEND の CRC は決まった値')
})

test('PNG: eXIf に向きがあれば、向きだけの eXIf を IHDR の直後に置き直す', () => {
  const src = Buffer.concat([PNG_SIG, IHDR, pngChunk('eXIf', exif(6).subarray(6)), IDAT, IEND])
  const r = stripImageMetadata(src, 'png')
  assert.deepEqual(r.bytes, Buffer.concat([PNG_SIG, IHDR, pngChunk('eXIf', orientationTiff(6)), IDAT, IEND]))
  assert.equal(r.bytes.indexOf('GPS'), -1)
  const upright = stripImageMetadata(Buffer.concat([PNG_SIG, IHDR, pngChunk('eXIf', exif(1).subarray(6)), IDAT, IEND]), 'png')
  assert.deepEqual(upright.bytes, Buffer.concat([PNG_SIG, IHDR, IDAT, IEND]), '向き 1 なら置かない')
})

test('PNG: 落とすものが無ければ入力そのもの。壊れていれば触らない', () => {
  assert.equal(stripImageMetadata(PNG_STRIPPED, 'png').bytes, PNG_STRIPPED)
  const broken = Buffer.concat([PNG_SIG, Buffer.from([0, 0, 1, 0, 0x74, 0x45, 0x58, 0x74, 1])])
  assert.equal(stripImageMetadata(broken, 'png').bytes, broken)
  assert.equal(stripImageMetadata(broken, 'png').unreadable, true)
})

/** WebP のチャンク（fourcc + 長さ LE + 中身 + 偶数詰め） */
const riff = (fourcc: string, data: Buffer) => {
  const out = Buffer.alloc(8 + data.length + (data.length % 2))
  out.write(fourcc, 0, 'latin1')
  out.writeUInt32LE(data.length, 4)
  data.copy(out, 8)
  return out
}
const webp = (...chunks: Buffer[]) => {
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(4 + body.length, 4)
  head.write('WEBP', 8, 'latin1')
  return Buffer.concat([head, body])
}
const vp8x = (flags: number) => riff('VP8X', Buffer.from([flags, 0, 0, 0, 0xff, 1, 0, 0x7f, 1, 0]))
export const WEBP_WITH_EXIF = webp(vp8x(0x2c), riff('ICCP', Buffer.alloc(5, 3)), riff('EXIF', Buffer.from('MM\0\x2aGPS', 'latin1')), riff('VP8 ', Buffer.alloc(7, 1)), riff('XMP ', Buffer.from('<x:xmpmeta>GPS</x:xmpmeta>', 'latin1')))
export const WEBP_STRIPPED = webp(vp8x(0x20), riff('ICCP', Buffer.alloc(5, 3)), riff('VP8 ', Buffer.alloc(7, 1)))

test('WebP: EXIF / XMP のチャンクを落とし、VP8X の印を消し、RIFF の長さを直す。ICCP と画素は残す', () => {
  const r = stripImageMetadata(WEBP_WITH_EXIF, 'webp')
  assert.equal(r.changed, true)
  assert.deepEqual(r.bytes, WEBP_STRIPPED)
  assert.equal(r.bytes.indexOf('GPS'), -1)
  assert.equal(r.bytes.readUInt32LE(4), r.bytes.length - 8, 'RIFF の長さ')
  assert.equal(stripImageMetadata(WEBP_STRIPPED, 'webp').bytes, WEBP_STRIPPED, '落とすものが無ければそのもの')
  const broken = Buffer.concat([WEBP_STRIPPED.subarray(0, 12), Buffer.from('EXIF\xff\xff\xff\xff', 'latin1')])
  assert.equal(stripImageMetadata(broken, 'webp').bytes, broken, '壊れていれば触らない')
})

test('GIF は触らない', () => {
  const gif = Buffer.from('GIF89a\x01\0\x01\0\0\0\0;', 'latin1')
  assert.equal(stripImageMetadata(gif, 'gif').bytes, gif)
})

test('2 回通しても同じ（自分で置いた向きだけの APP1 / eXIf は落として置き直さない。変わった、にもならない）', () => {
  const once = stripImageMetadata(jpeg(APP0, seg(0xe1, exif(6)), ICC, DQT, SOF), 'jpeg')
  const twice = stripImageMetadata(once.bytes, 'jpeg')
  assert.equal(twice.changed, false)
  assert.equal(twice.bytes, once.bytes, '同じ Buffer')
  const png1 = stripImageMetadata(Buffer.concat([PNG_SIG, IHDR, pngChunk('eXIf', exif(6).subarray(6)), IDAT, IEND]), 'png')
  const png2 = stripImageMetadata(png1.bytes, 'png')
  assert.equal(png2.changed, false)
  assert.equal(png2.bytes, png1.bytes)
})

test('JPEG: プログレッシブ（SOS の間に DQT / DHT）で、セグメントの中身の FFD9 を EOI と取り違えない', () => {
  const dqtWithFfd9 = seg(0xdb, Buffer.concat([Buffer.from([0x10]), Buffer.alloc(60, 0), Buffer.from([0xff, 0xd9]), Buffer.alloc(66, 1)]))
  const sos = (n: number) => seg(0xda, Buffer.from([1, n, 0, 0, 63, 0]))
  const scan = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])
  const src = Buffer.concat([SOI, APP0, COM, DQT, SOF, sos(1), scan, dqtWithFfd9, sos(2), scan, Buffer.from([0xff, 0xd9]), Buffer.from('trailer')])
  const r = stripImageMetadata(src, 'jpeg')
  assert.deepEqual(r.bytes, Buffer.concat([SOI, APP0, DQT, SOF, sos(1), scan, dqtWithFfd9, sos(2), scan, Buffer.from([0xff, 0xd9])]), 'COM と末尾の trailer だけが落ち、2 つ目の走査は残る')
})
