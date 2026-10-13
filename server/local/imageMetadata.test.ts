// 画像のメタデータを落とす（#791）。作り物の JPEG / PNG で、落とすもの（EXIF / XMP / IPTC / COM、PNG の文字のチャンク）と
// 残すもの（ICC・画素・向き）を見る。本物の写真での確認（magick identify で exif: が 0 件・ICC が残る）は PR に書く
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exifOrientation, orientationSegment, stripImageMetadata } from './imageMetadata.ts'
import { imageSize } from './thumbnails.ts'

/** JPEG のセグメント（マーカー + 長さ + 中身） */
const seg = (marker: number, payload: Buffer) => {
  const out = Buffer.alloc(4 + payload.length)
  out[0] = 0xff
  out[1] = marker
  out.writeUInt16BE(payload.length + 2, 2)
  payload.copy(out, 4)
  return out
}
/** EXIF（TIFF、ビッグエンディアン）。IFD0 に Orientation と GPS IFD へのポインタ */
const exif = (orientation: number, order: 'II' | 'MM' = 'MM') => {
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
  w16(3, 12)
  w32(1, 14)
  w16(orientation, 18)
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
const SOI = Buffer.from([0xff, 0xd8])
const APP0 = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'))
const ICC = seg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'), Buffer.alloc(40, 7)]))
const XMP = seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPS</x:xmpmeta>', 'latin1'))
const IPTC = seg(0xed, Buffer.from('Photoshop 3.0\0' + '8BIM'.padEnd(20, '\0'), 'latin1'))
const COM = seg(0xfe, Buffer.from('a comment', 'latin1'))
const DQT = seg(0xdb, Buffer.alloc(65, 1))
/** SOF0: 高さ 384・幅 512 */
const SOF = seg(0xc0, Buffer.from([8, 1, 128, 2, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]))
/** SOS 以降（画素。RST と FF00 の詰め物を含む）と EOI */
const TAIL = Buffer.concat([seg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0])), Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9])])

const jpeg = (...middle: Buffer[]) => Buffer.concat([SOI, ...middle, TAIL])

test('JPEG: EXIF / XMP / IPTC / COM を落とし、ICC・DQT・SOF・画素は残す。向き 1 なら APP1 は残らない', () => {
  const src = jpeg(APP0, seg(0xe1, exif(1)), ICC, XMP, IPTC, COM, DQT, SOF)
  const r = stripImageMetadata(src, 'jpeg')
  assert.equal(r.changed, true)
  assert.equal(r.orientation, 1)
  assert.deepEqual(r.bytes, jpeg(APP0, ICC, DQT, SOF), '残るものは順番もそのまま')
  assert.deepEqual(imageSize(r.bytes, 'jpeg'), { width: 512, height: 384 })
  assert.equal(r.bytes.indexOf('GPS'), -1)
})

test('JPEG: 向きが 1 以外なら、向きだけの最小の APP1 を SOI の直後に置く（GPS は残らない）', () => {
  for (const order of ['MM', 'II'] as const) {
    const r = stripImageMetadata(jpeg(APP0, seg(0xe1, exif(6, order)), ICC, DQT, SOF), 'jpeg')
    assert.equal(r.orientation, 6, order)
    assert.deepEqual(r.bytes, jpeg(orientationSegment(6), APP0, ICC, DQT, SOF), order)
    assert.equal(exifOrientation(orientationSegment(6).subarray(4)), 6, '置いた APP1 を読み返すと 6')
    assert.equal(orientationSegment(6).length, 36)
  }
})

test('JPEG: 落とすものが無ければ入力そのもの。壊れていれば触らない', () => {
  const clean = jpeg(APP0, ICC, DQT, SOF)
  const r = stripImageMetadata(clean, 'jpeg')
  assert.equal(r.changed, false)
  assert.equal(r.bytes, clean, '同じ Buffer')
  // セグメントの長さがファイルの外を指す
  const broken = Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0xff, 0xff, 1, 2])])
  assert.equal(stripImageMetadata(broken, 'jpeg').bytes, broken)
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

test('exifOrientation: 形が違えば undefined', () => {
  assert.equal(exifOrientation(Buffer.from('nope')), undefined)
  assert.equal(exifOrientation(Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('XX\0\x2a\0\0\0\x08')])), undefined)
  const bad = exif(9)
  assert.equal(exifOrientation(bad), undefined, '1〜8 の外')
})

/** PNG のチャンク（長さ + 種類 + 中身 + CRC（偽）） */
const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(0xdeadbeef, 8 + data.length)
  return out
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IHDR = chunk('IHDR', Buffer.from([0, 0, 2, 0, 0, 0, 1, 0x80, 8, 2, 0, 0, 0]))
const ICCP = chunk('iCCP', Buffer.from('Display P3\0\0abc', 'latin1'))
const IDAT = chunk('IDAT', Buffer.alloc(16, 9))
const IEND = chunk('IEND', Buffer.alloc(0))

test('PNG: eXIf / tEXt / zTXt / iTXt を落とし、iCCP・IHDR・IDAT は残す', () => {
  const src = Buffer.concat([PNG_SIG, IHDR, ICCP, chunk('tEXt', Buffer.from('Comment\0made by', 'latin1')), chunk('eXIf', Buffer.from('MM\0\x2aGPS', 'latin1')), IDAT, chunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x/>', 'latin1')), chunk('zTXt', Buffer.alloc(8)), IEND])
  const r = stripImageMetadata(src, 'png')
  assert.equal(r.changed, true)
  assert.deepEqual(r.bytes, Buffer.concat([PNG_SIG, IHDR, ICCP, IDAT, IEND]))
  assert.deepEqual(imageSize(r.bytes, 'png'), { width: 512, height: 384 })
})

test('PNG: 落とすものが無ければ入力そのもの。壊れていれば触らない。GIF / WebP は触らない', () => {
  const clean = Buffer.concat([PNG_SIG, IHDR, IDAT, IEND])
  assert.equal(stripImageMetadata(clean, 'png').bytes, clean)
  const broken = Buffer.concat([PNG_SIG, Buffer.from([0, 0, 1, 0, 0x74, 0x45, 0x58, 0x74, 1])])
  assert.equal(stripImageMetadata(broken, 'png').bytes, broken)
  assert.equal(stripImageMetadata(Buffer.from('GIF89a'), 'gif').changed, false)
  assert.equal(stripImageMetadata(Buffer.from('RIFF....WEBP'), 'webp').changed, false)
})
