// 画像の軽い版（#589）。本物の createApp に一時の feed dir・作業ディレクトリ・偽の縮める口を渡して、
// `?thumb=<版>` が軽い版を返し、付けなければ・ダウンロードなら元のまま、縮められなければ 503 で「押すまで読まない」形になること、
// 縮める口に渡るのが置き場に書いたファイルだけで、cwd の外・シンボリックリンク・SVG・上限超えでは呼ばれないことを見る
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { hasAlpha, imageSize, noThumbs, THUMB_BAND_EDGE_MAX, THUMB_BAND_SHORT, THUMB_EDGE, THUMB_EDGE_ALPHA, THUMB_FAILED_TTL_MS, THUMB_MIN_BYTES, THUMB_STRIPPED_MARK, thumbTarget, Thumbnails } from './local/thumbnails.ts'
import type { Shrinker, ThumbFormat } from './local/thumbnails.ts'
import { IMAGE_MAX_BYTES, sessionImageUrl, THUMB_VERSION, thumbUrl } from '../shared/images.ts'
import { JPEG_STRIPPED, JPEG_WITH_EXIF } from './local/imageMetadata.test.ts'

/** IHDR の色の種類（2 = RGB、6 = RGBA）を持つ PNG に見えるもの。中身の判定は先頭の印だけを見る */
const png = (size: number, colorType = 2) => {
  const b = Buffer.alloc(size)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b)
  b[25] = colorType
  return b
}
const JPEG_THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const PNG_THUMB = png(64, 6)

let dir: string
let thumbsDir: string
let server: Server
let serverNoSips: Server
let base: string
let baseNoSips: string
/** 縮める口に渡ったもの */
let calls: { input: string; output: string; format: ThumbFormat }[] = []
const fake: Shrinker = async (input, output, format) => {
  calls.push({ input, output, format })
  await writeFile(output, format === 'jpeg' ? JPEG_THUMB : PNG_THUMB)
}

const url = (src: string) => `${sessionImageUrl('S1@repo', src)}`
const listen = async (app: ReturnType<typeof createApp>) => {
  const s = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  const addr = s.address()
  return { s, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-thumbs-'))
  const feedDir = join(dir, 'feed')
  const cwd = join(dir, 'work')
  thumbsDir = join(dir, 'thumbs')
  await mkdir(feedDir)
  await mkdir(cwd)
  await mkdir(join(dir, 'elsewhere'))
  await writeFile(join(cwd, 'big.png'), png(THUMB_MIN_BYTES + 1))
  await writeFile(join(cwd, 'alpha.png'), png(THUMB_MIN_BYTES + 1, 6))
  await writeFile(join(cwd, 'small.png'), png(1024))
  await writeFile(join(cwd, 'exif.jpg'), JPEG_WITH_EXIF) // しきい値未満。枠に出すときも落とす（#791 の 4 回目のレビュー）
  await writeFile(join(cwd, 'fake.png'), `<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(THUMB_MIN_BYTES)}</svg>`)
  await writeFile(join(cwd, 'huge.png'), png(16))
  await truncate(join(cwd, 'huge.png'), IMAGE_MAX_BYTES + 1)
  await writeFile(join(dir, 'elsewhere', 'secret.png'), png(THUMB_MIN_BYTES + 1))
  await symlink(join(dir, 'elsewhere', 'secret.png'), join(cwd, 'link.png'))
  const now = new Date()
  const text = ['big', 'alpha', 'small', 'fake', 'huge', 'link'].map((n) => `![${n}](${n}.png)`).join('\n') + `\n![s](${join(dir, 'elsewhere', 'secret.png')})\n![e](exif.jpg)`
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), JSON.stringify(row(now, 'S1', { repo: 'repo', cwd, text })) + '\n')

  const a = await listen(createApp(new FeedStore(feedDir), join(dir, 'dist'), undefined, undefined, undefined, undefined, undefined, { tmux: { run: async () => '' }, ps: async () => '', thumbs: new Thumbnails(thumbsDir, fake) }))
  server = a.s
  base = a.base
  const b = await listen(createApp(new FeedStore(feedDir), join(dir, 'dist'), undefined, undefined, undefined, undefined, undefined, { tmux: { run: async () => '' }, ps: async () => '', thumbs: noThumbs }))
  serverNoSips = b.s
  baseNoSips = b.base
})

beforeEach(() => {
  calls = []
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => serverNoSips.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

test('?thumb=<版> は元より小さい JPEG を返し、付けなければ・ダウンロードなら元のまま', async () => {
  const thumb = await fetch(base + thumbUrl(url('big.png')))
  assert.equal(thumb.status, 200)
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg')
  assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), JPEG_THUMB)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.format, 'jpeg')
  assert.equal(dirname(calls[0]!.input), thumbsDir, '縮める口に渡るのは置き場に書いたファイルだけ（元のパスは渡さない）')
  assert.ok(!(await readdir(thumbsDir)).some((n) => n.endsWith('.src')), '渡したファイルは片付ける')

  const original = await fetch(base + url('big.png'))
  assert.equal(original.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.from(await original.arrayBuffer()).length, THUMB_MIN_BYTES + 1)
  const dl = await fetch(`${base}${url('big.png')}?download=1&thumb=${THUMB_VERSION}`)
  assert.equal(Buffer.from(await dl.arrayBuffer()).length, THUMB_MIN_BYTES + 1, 'ダウンロードは元の画像')
  assert.notEqual(thumb.headers.get('etag'), original.headers.get('etag'), '軽い版と元は別の ETag')

  // 2 回目は置き場から（縮め直さない）。ETag が合えば 304
  const again = await fetch(base + thumbUrl(url('big.png')), { headers: { 'If-None-Match': thumb.headers.get('etag')! } })
  assert.equal(again.status, 304)
  assert.equal((await fetch(base + thumbUrl(url('big.png')))).status, 200)
  assert.equal(calls.length, 1, '同じ中身は縮め直さない')
})

test('?thumb=<版>: しきい値未満は元のまま（縮めない）。透過のある PNG は PNG のまま縮める', async () => {
  const small = await fetch(base + thumbUrl(url('small.png')))
  assert.equal(small.status, 200)
  assert.equal(Buffer.from(await small.arrayBuffer()).length, 1024)
  const alpha = await fetch(base + thumbUrl(url('alpha.png')))
  assert.equal(alpha.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await alpha.arrayBuffer()), PNG_THUMB)
  assert.deepEqual(calls.map((c) => c.format), ['png'])
})

test('?thumb=<版>: cwd の外・シンボリックリンク・SVG・上限超えでは縮める口を呼ばない', async () => {
  assert.equal((await fetch(base + thumbUrl(url(join(dir, 'elsewhere', 'secret.png'))))).status, 403)
  assert.equal((await fetch(base + thumbUrl(url('link.png')))).status, 403)
  assert.equal((await fetch(base + thumbUrl(url('fake.png')))).status, 415)
  assert.equal((await fetch(base + thumbUrl(url('huge.png')))).status, 413)
  assert.deepEqual(calls, [])
})

test('?thumb=<版>: 縮められなければ 503 と元の大きさ（画面は押すまで元を読まない）。元の URL はそのまま配る', async () => {
  const res = await fetch(baseNoSips + thumbUrl(url('big.png')))
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('x-sai-thumb'), 'unavailable')
  assert.equal(res.headers.get('x-sai-image-bytes'), String(THUMB_MIN_BYTES + 1))
  assert.equal((await fetch(baseNoSips + thumbUrl(url('small.png')))).status, 200, '軽い画像はそのまま')
  assert.equal((await fetch(baseNoSips + url('big.png'))).status, 200)
})

test('Thumbnails: 失敗・締切は unavailable。sips が無ければ以後は呼ばない。縮めても重ければ元のまま', async () => {
  const d = await mkdtemp(join(tmpdir(), 'sai-thumbs-unit-'))
  try {
    const big = { bytes: png(THUMB_MIN_BYTES + 10), type: 'png' as const }
    assert.deepEqual(await new Thumbnails(d, async () => Promise.reject(new Error('timeout'))).thumb(big), { kind: 'unavailable' })
    let n = 0
    const missing = new Thumbnails(d, async () => {
      n++
      throw Object.assign(new Error('spawn sips ENOENT'), { code: 'ENOENT', path: 'sips' })
    })
    assert.deepEqual(await missing.thumb(big), { kind: 'unavailable' })
    assert.deepEqual(await missing.thumb({ bytes: png(THUMB_MIN_BYTES + 20), type: 'png' }), { kind: 'unavailable' })
    assert.equal(n, 1)
    const heavier = new Thumbnails(d, async (_i, o) => writeFile(o, png(THUMB_MIN_BYTES + 100)))
    assert.deepEqual(await heavier.thumb({ bytes: png(THUMB_MIN_BYTES + 30), type: 'png' }), { kind: 'original' })
    // 同じ中身を同時に頼まれても 1 回だけ縮める
    let m = 0
    const once = new Thumbnails(d, async (_i, o) => {
      m++
      await writeFile(o, JPEG_THUMB)
    })
    const same = { bytes: png(THUMB_MIN_BYTES + 40), type: 'png' as const }
    await Promise.all([once.thumb(same), once.thumb(same), once.thumb(same)])
    assert.equal(m, 1)
  } finally {
    await rm(d, { recursive: true, force: true })
  }
})

test('Thumbnails: 縮められなかった中身は覚えて、しばらく sips を回し直さない（#593 のレビュー）', async () => {
  const d = await mkdtemp(join(tmpdir(), 'sai-thumbs-failed-'))
  try {
    let t = 0
    let n = 0
    const th = new Thumbnails(d, async () => {
      n++
      throw new Error('timeout')
    }, () => t)
    const big = { bytes: png(THUMB_MIN_BYTES + 50), type: 'png' as const }
    assert.deepEqual(await th.thumb(big), { kind: 'unavailable' })
    assert.deepEqual(await th.thumb(big), { kind: 'unavailable' })
    assert.equal(n, 1, '画面の見分けの HEAD では回し直さない')
    t = THUMB_FAILED_TTL_MS
    await th.thumb(big)
    assert.equal(n, 2, '時間が経てばまた試す')
  } finally {
    await rm(d, { recursive: true, force: true })
  }
})

test('Thumbnails: 目標より小さい画像は引き伸ばさない（PNG は元のまま、JPEG は大きさを変えずに作り直す。#593 のレビュー）', async () => {
  const d = await mkdtemp(join(tmpdir(), 'sai-thumbs-small-'))
  try {
    const edges: number[] = []
    const th = new Thumbnails(d, async (_i, o, _f, edge) => {
      edges.push(edge)
      await writeFile(o, JPEG_THUMB)
    })
    const sized = (w: number, h: number, colorType: number) => {
      const b = png(THUMB_MIN_BYTES + w + colorType, colorType)
      b.writeUInt32BE(w, 16)
      b.writeUInt32BE(h, 20)
      return { bytes: b, type: 'png' as const }
    }
    assert.deepEqual(await th.thumb(sized(300, 200, 6)), { kind: 'original' }, '透過のある 300px は縮めない')
    assert.equal((await th.thumb(sized(300, 200, 2))).kind, 'thumb')
    assert.equal((await th.thumb(sized(2000, 1000, 2))).kind, 'thumb')
    assert.deepEqual(edges, [300, 512])
  } finally {
    await rm(d, { recursive: true, force: true })
  }
})

test('Thumbnails: 横に細長い画像（帯）は短辺を保って長辺を伸ばす。前に長辺 512px で作った軽い版は返さない（#709）', async () => {
  const d = await mkdtemp(join(tmpdir(), 'sai-thumbs-band-'))
  try {
    const made: { edge: number; out: string }[] = []
    const th = new Thumbnails(d, async (_i, o, _f, edge) => {
      made.push({ edge, out: o })
      await writeFile(o, JPEG_THUMB)
    })
    const sized = (w: number, h: number, colorType = 2) => {
      const b = png(THUMB_MIN_BYTES + w + h + colorType, colorType)
      b.writeUInt32BE(w, 16)
      b.writeUInt32BE(h, 20)
      return { bytes: b, type: 'png' as const }
    }
    const band = sized(2880, 200)
    // 前の版が置いた、長辺 512px の軽い版（名前は中身のハッシュだけ）
    const hash = createHash('sha256').update(band.bytes).digest('hex').slice(0, 32)
    await writeFile(join(d, `${hash}.jpg`), JPEG_THUMB)
    assert.equal((await th.thumb(band)).kind, 'thumb')
    assert.deepEqual(made.map((m) => m.edge), [(2880 / 200) * THUMB_BAND_SHORT], '14.4:1 は短辺 120px = 長辺 1728px')
    assert.ok((await readdir(d)).includes(`${hash}-1728.jpg`), '帯の軽い版は名前を分けて置く')
    await th.thumb(band)
    assert.equal(made.length, 1, '2 回目は置き場から')
    // ふつうの画像・縦長は今までどおり長辺 512px
    await th.thumb(sized(2000, 1000))
    await th.thumb(sized(200, 2880))
    assert.deepEqual(made.slice(1).map((m) => m.edge), [THUMB_EDGE, THUMB_EDGE])
  } finally {
    await rm(d, { recursive: true, force: true })
  }
})

test('?thumb=1（古い画面）でも軽い版を返す（#791 のレビュー。受けないと元の画像を枠に読む）', async () => {
  const res = await fetch(`${base}${url('big.png')}?thumb=1`)
  assert.equal(res.status, 200)
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG_THUMB)
  const off = await fetch(`${base}${url('big.png')}?thumb=0`)
  assert.equal(Buffer.from(await off.arrayBuffer()).length, THUMB_MIN_BYTES + 1, 'thumb=0 は付いていない扱い')
})

test('Thumbnails: sips が残した EXIF は置く前に落とす（#791）', async () => {
  const d = await mkdtemp(join(tmpdir(), 'sai-th-exif-'))
  try {
    const th = new Thumbnails(d, async (_i, o) => writeFile(o, JPEG_WITH_EXIF))
    const r = await th.thumb({ bytes: png(THUMB_MIN_BYTES + 1), type: 'png' })
    assert.equal(r.kind, 'thumb')
    assert.deepEqual(r.kind === 'thumb' && r.bytes, JPEG_STRIPPED, '返すものにも EXIF は無い')
    const stored = (await readdir(d)).filter((n) => n.endsWith('.jpg'))
    assert.equal(stored.length, 1)
    assert.deepEqual(await readFile(join(d, stored[0]!)), JPEG_STRIPPED, '置いたものにも無い')
    await stat(join(d, THUMB_STRIPPED_MARK)) // 置き場を作ったときに印も置く（古い軽い版は無い）
  } finally {
    await rm(d, { recursive: true, force: true })
  }
})

test('Thumbnails: 前からある軽い版と作りかけは起動時に消して印を置く。印があれば軽い版は消さない（#791）', async () => {
  const d = await mkdtemp(join(tmpdir(), 'sai-th-clean-'))
  try {
    const gps = `${'a'.repeat(32)}.jpg`
    const band = `${'b'.repeat(32)}-1728.jpg`
    const src = `${'c'.repeat(32)}.src`
    const work = `${'c'.repeat(32)}.tmp.jpg`
    await writeFile(join(d, gps), JPEG_WITH_EXIF)
    await writeFile(join(d, band), JPEG_WITH_EXIF)
    await writeFile(join(d, src), JPEG_WITH_EXIF)
    await writeFile(join(d, work), JPEG_WITH_EXIF)
    await writeFile(join(d, 'notes.txt'), 'x')
    const stale = new Date(Date.now() - 60_000)
    await utimes(join(d, src), stale, stale)
    await utimes(join(d, work), stale, stale)
    assert.deepEqual(await new Thumbnails(d, fake).ready(), { removed: 4, marked: true })
    assert.deepEqual((await readdir(d)).sort(), [THUMB_STRIPPED_MARK, 'notes.txt'], '軽い版・作りかけは消え、ほかは触らない')
    // 印があれば軽い版は消さない。作りかけ（前の SAI が落ちたもの）は毎回消す。ただし sips の締切より新しいもの（別の SAI が作っている最中）は残す
    await writeFile(join(d, gps), JPEG_WITH_EXIF)
    await writeFile(join(d, src), JPEG_WITH_EXIF)
    await writeFile(join(d, work), JPEG_WITH_EXIF)
    const old = new Date(Date.now() - 60_000)
    await utimes(join(d, src), old, old)
    assert.deepEqual(await new Thumbnails(d, fake).ready(), { removed: 1, marked: true })
    assert.deepEqual((await readdir(d)).sort(), [THUMB_STRIPPED_MARK, gps, work, 'notes.txt'])
  } finally {
    await rm(d, { recursive: true, force: true })
  }
})

test('Thumbnails: 置いてある軽い版を読むときにも落とし、落ちたら置き直す（古い SAI が同じ置き場に書いた分。#791）', async () => {
  const d = await mkdtemp(join(tmpdir(), 'sai-th-lazy-'))
  try {
    const img = { bytes: png(THUMB_MIN_BYTES + 1), type: 'png' as const }
    const th = new Thumbnails(d, async (_i, o) => writeFile(o, JPEG_STRIPPED))
    await th.thumb(img)
    const [name] = (await readdir(d)).filter((n) => n.endsWith('.jpg'))
    await writeFile(join(d, name!), JPEG_WITH_EXIF) // 印の後に、古い SAI が GPS 付きを書いたのと同じ状態
    const r = await new Thumbnails(d, fake).thumb(img)
    assert.deepEqual(r.kind === 'thumb' && r.bytes, JPEG_STRIPPED, '配るものには無い')
    assert.deepEqual(await readFile(join(d, name!)), JPEG_STRIPPED, '置いてあるものも直る')
    assert.ok(!(await readdir(d)).some((n) => n.endsWith('.tmp')), 'tmp は残らない')
  } finally {
    await rm(d, { recursive: true, force: true })
  }
})

test('Thumbnails: 置き場がまだ無ければ作って印だけ置き、最初の thumb() はそれを待ってから進む（#791）', async () => {
  const d = join(await mkdtemp(join(tmpdir(), 'sai-th-none-')), 'thumbs')
  try {
    const th = new Thumbnails(d, fake)
    assert.deepEqual(await th.ready(), { removed: 0, marked: true })
    assert.equal((await th.thumb({ bytes: png(THUMB_MIN_BYTES + 1), type: 'png' })).kind, 'thumb')
  } finally {
    await rm(dirname(d), { recursive: true, force: true })
  }
})

test('thumbTarget: 帯だけ長辺を伸ばす。上限と、ふつうの画像の長辺を下回らないこと（#709）', () => {
  assert.equal(thumbTarget({ width: 2000, height: 1000 }, THUMB_EDGE), THUMB_EDGE)
  assert.equal(thumbTarget(null, THUMB_EDGE), THUMB_EDGE, '大きさが読めなければ今までどおり')
  assert.equal(thumbTarget({ width: 1279, height: 320 }, THUMB_EDGE), THUMB_EDGE, '4:1 の手前は帯ではない')
  assert.equal(thumbTarget({ width: 1280, height: 320 }, THUMB_EDGE), THUMB_EDGE, '4:1 ちょうどは短辺 120px で 480px。512px を下回らせない')
  assert.equal(thumbTarget({ width: 1280, height: 320 }, THUMB_EDGE_ALPHA), 4 * THUMB_BAND_SHORT)
  assert.equal(thumbTarget({ width: 2880, height: 200 }, THUMB_EDGE), 1728)
  assert.equal(thumbTarget({ width: 30000, height: 200 }, THUMB_EDGE), THUMB_BAND_EDGE_MAX, 'とても長い帯は上限まで')
})

test('imageSize: 見出しから縦横を読む（PNG / GIF / JPEG）', () => {
  const p = png(64)
  p.writeUInt32BE(1024, 16)
  p.writeUInt32BE(1536, 20)
  assert.deepEqual(imageSize(p, 'png'), { width: 1024, height: 1536 })
  const g = Buffer.from('GIF89a\x40\x01\xc8\x00', 'latin1')
  assert.deepEqual(imageSize(g, 'gif'), { width: 320, height: 200 })
  // SOI → APP0（長さ 4）→ SOF0（高さ 480・幅 640）
  const j = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0, 0])
  assert.deepEqual(imageSize(j, 'jpeg'), { width: 640, height: 480 })
  assert.equal(imageSize(Buffer.from([0xff, 0xd8]), 'jpeg'), null)
})

test('hasAlpha: PNG は IHDR の色の種類か IDAT より前の tRNS、JPEG は無し', () => {
  assert.equal(hasAlpha(png(64, 2), 'png'), false)
  assert.equal(hasAlpha(png(64, 6), 'png'), true)
  assert.equal(hasAlpha(png(64, 4), 'png'), true)
  const trns = png(64, 3)
  trns.write('tRNS', 40)
  trns.write('IDAT', 50)
  assert.equal(hasAlpha(trns, 'png'), true)
  assert.equal(hasAlpha(Buffer.from([0xff, 0xd8, 0xff]), 'jpeg'), false)
})

test('cwd の画像を枠に出すとき、軽い版を作らず元のまま配る道でも EXIF は落とす。ライトボックス・ダウンロードは元のまま（#791 の 4 回目のレビュー）', async () => {
  const frame = await fetch(base + thumbUrl(url('exif.jpg')))
  assert.equal(frame.status, 200)
  assert.deepEqual(Buffer.from(await frame.arrayBuffer()), JPEG_STRIPPED)
  assert.deepEqual(Buffer.from(await (await fetch(base + url('exif.jpg'))).arrayBuffer()), JPEG_WITH_EXIF)
  assert.deepEqual(Buffer.from(await (await fetch(`${base}${url('exif.jpg')}?download=1&thumb=${THUMB_VERSION}`)).arrayBuffer()), JPEG_WITH_EXIF)
})
