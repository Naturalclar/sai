// 画像の軽い版（#589）。本物の createApp に一時の feed dir・作業ディレクトリ・偽の縮める口を渡して、
// `?thumb=1` が軽い版を返し、付けなければ・ダウンロードなら元のまま、縮められなければ 503 で「押すまで読まない」形になること、
// 縮める口に渡るのが置き場に書いたファイルだけで、cwd の外・シンボリックリンク・SVG・上限超えでは呼ばれないことを見る
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { hasAlpha, noThumbs, THUMB_MIN_BYTES, Thumbnails } from './local/thumbnails.ts'
import type { Shrinker, ThumbFormat } from './local/thumbnails.ts'
import { IMAGE_MAX_BYTES, sessionImageUrl, thumbUrl } from '../shared/images.ts'

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
  await writeFile(join(cwd, 'fake.png'), `<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(THUMB_MIN_BYTES)}</svg>`)
  await writeFile(join(cwd, 'huge.png'), png(16))
  await truncate(join(cwd, 'huge.png'), IMAGE_MAX_BYTES + 1)
  await writeFile(join(dir, 'elsewhere', 'secret.png'), png(THUMB_MIN_BYTES + 1))
  await symlink(join(dir, 'elsewhere', 'secret.png'), join(cwd, 'link.png'))
  const now = new Date()
  const text = ['big', 'alpha', 'small', 'fake', 'huge', 'link'].map((n) => `![${n}](${n}.png)`).join('\n') + `\n![s](${join(dir, 'elsewhere', 'secret.png')})`
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

test('?thumb=1 は元より小さい JPEG を返し、付けなければ・ダウンロードなら元のまま', async () => {
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
  const dl = await fetch(`${base}${url('big.png')}?download=1&thumb=1`)
  assert.equal(Buffer.from(await dl.arrayBuffer()).length, THUMB_MIN_BYTES + 1, 'ダウンロードは元の画像')
  assert.notEqual(thumb.headers.get('etag'), original.headers.get('etag'), '軽い版と元は別の ETag')

  // 2 回目は置き場から（縮め直さない）。ETag が合えば 304
  const again = await fetch(base + thumbUrl(url('big.png')), { headers: { 'If-None-Match': thumb.headers.get('etag')! } })
  assert.equal(again.status, 304)
  assert.equal((await fetch(base + thumbUrl(url('big.png')))).status, 200)
  assert.equal(calls.length, 1, '同じ中身は縮め直さない')
})

test('?thumb=1: しきい値未満は元のまま（縮めない）。透過のある PNG は PNG のまま縮める', async () => {
  const small = await fetch(base + thumbUrl(url('small.png')))
  assert.equal(small.status, 200)
  assert.equal(Buffer.from(await small.arrayBuffer()).length, 1024)
  const alpha = await fetch(base + thumbUrl(url('alpha.png')))
  assert.equal(alpha.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await alpha.arrayBuffer()), PNG_THUMB)
  assert.deepEqual(calls.map((c) => c.format), ['png'])
})

test('?thumb=1: cwd の外・シンボリックリンク・SVG・上限超えでは縮める口を呼ばない', async () => {
  assert.equal((await fetch(base + thumbUrl(url(join(dir, 'elsewhere', 'secret.png'))))).status, 403)
  assert.equal((await fetch(base + thumbUrl(url('link.png')))).status, 403)
  assert.equal((await fetch(base + thumbUrl(url('fake.png')))).status, 415)
  assert.equal((await fetch(base + thumbUrl(url('huge.png')))).status, 413)
  assert.deepEqual(calls, [])
})

test('?thumb=1: 縮められなければ 503 と元の大きさ（画面は押すまで元を読まない）。元の URL はそのまま配る', async () => {
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
