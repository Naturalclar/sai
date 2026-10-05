// 画像の軽い版（#589）。バブルの下の枠（96px）や本文の中（最大 320px）に元の画像（Codex の生成画像は 1 枚 2MB 前後）を読ませず、
// 長辺を縮めた版を返す。**縮めるのは PATH の `sips`（macOS 付属）**で、`server/` に依存は足さない（Node に画像のコーデックは無い）。
//
// **`sips` に渡すのは、ここで置き場に書いたファイルだけ**: 配る口（readSessionImage / transcriptImages / codexImages / 添付）が
// 今の読み方（realpath が置き場の中・中身で種類を判定・上限以下）で読み終えたバイト列を受け取り、置き場に中身のハッシュの名前で書いてから渡す。
// リクエストから来た文字列も、元のファイルのパスも渡さない。出来たものは同じ置き場に中身のハッシュで置く（派生なので消してよい）。
//
// 返すのは 3 つ: しきい値未満は `original`（縮めるほうが高い）、縮めたら `thumb`、`sips` が無い・失敗・締切なら `unavailable`
// （画面は押すまで元を読まない。#589 の案 2）
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IconType } from '../../shared/icon.ts'
import { isBandImage } from '../../shared/images.ts'

/** これより軽い画像は縮めずに元のまま返す（実測: 100KB 未満が 306 枚中 131 枚。縮める 0.1〜0.5 秒のほうが高い） */
export const THUMB_MIN_BYTES = 200 * 1024
/** 長辺。枠は 96px・本文の中は 320px で、携帯は 3 倍の画素で描く。512px の JPEG（品質 75）で 2MB の生成画像が 60KB 前後 */
export const THUMB_EDGE = 512
export const THUMB_QUALITY = 75
/**
 * 透過のある画像（PNG のまま縮める）の長辺。PNG は縮めても軽くならないので小さめにする（実測: Codex の生成画像の RGBA 1254px で
 * 512px なら 124〜290KB、384px なら 75〜175KB。枠の 96px を 3 倍の画素で描いても 288px で足りる）
 */
export const THUMB_EDGE_ALPHA = 384
/**
 * 横に細長い画像（帯。`shared/images.ts` の `isBandImage()`）の軽い版の短辺（#709）。画面は帯を高さ 80px まで広げるので、
 * 長辺 512px のまま（14:1 なら高さ 36px）だと広がらず字も読めない。短辺をこの値にして長辺を伸ばす（80px の 1.5 倍の画素）。
 * 実測（2880×200・344KB の表のスクリーンショット）: 長辺 512px で 11KB、短辺 80px で 52KB、120px で 90KB 前後、160px で 155KB
 */
export const THUMB_BAND_SHORT = 120
/** 帯の軽い版の長辺の上限（とても長い帯で元に近い大きさを作らない） */
export const THUMB_BAND_EDGE_MAX = 2048
/** `sips` 1 回の締切 */
export const THUMB_TIMEOUT_MS = 15_000
/** 同時に回す `sips` の数 */
export const THUMB_CONCURRENCY = 2
/** 縮められなかった中身を覚えておく長さ。画面の見分けの HEAD や開き直しのたびに `sips` を回し直さない（#593 のレビュー） */
export const THUMB_FAILED_TTL_MS = 10 * 60_000
/** 置き場に残す軽い版の数。超えたら古いものから捨てる（1 枚 30〜80KB なので 1000 枚で 50MB 前後） */
export const THUMB_KEEP = 1000

export type ThumbFormat = 'jpeg' | 'png'

/** 縮める口。`input` を長辺 `edge` にして `format` で `output` に書く。テストは偽物を渡す */
export type Shrinker = (input: string, output: string, format: ThumbFormat, edge: number) => Promise<void>

/** 本物の縮める口。`sips` の形は決め打ち（渡すのはここで書いたファイルのパスだけ） */
export const sipsShrink: Shrinker = (input, output, format, edge) =>
  new Promise((resolve, reject) => {
    const args = ['-s', 'format', format, ...(format === 'jpeg' ? ['-s', 'formatOptions', String(THUMB_QUALITY)] : []), '-Z', String(Math.max(1, Math.floor(edge))), input, '--out', output]
    execFile('sips', args, { timeout: THUMB_TIMEOUT_MS, windowsHide: true }, (err) => (err ? reject(err) : resolve()))
  })

export type ThumbResult = { kind: 'original' } | { kind: 'thumb'; bytes: Buffer; type: IconType } | { kind: 'unavailable' }

export interface ThumbMaker {
  thumb(img: { bytes: Buffer; type: IconType }): Promise<ThumbResult>
}

/** 軽い版を作らない（`createApp` にこれを渡すと、重い画像は押すまで読まない形になる） */
export const noThumbs: ThumbMaker = {
  thumb: async (img) => (img.bytes.length < THUMB_MIN_BYTES ? { kind: 'original' } : { kind: 'unavailable' }),
}

/**
 * 透過があるか。JPEG にすると透けていた所が白で埋まる（sips で実測）ので、あれば PNG のまま縮める。
 * PNG は IHDR の色の種類（4 = グレー＋α、6 = RGBA）か、IDAT より前の `tRNS`。GIF・WebP は透過のことが多いので PNG にする
 */
export function hasAlpha(bytes: Buffer, type: IconType): boolean {
  if (type === 'jpeg') return false
  if (type !== 'png') return true
  const colorType = bytes[25]
  if (colorType === 4 || colorType === 6) return true
  const idat = bytes.indexOf('IDAT')
  const trns = bytes.indexOf('tRNS')
  return trns >= 0 && (idat < 0 || trns < idat)
}

/**
 * 画素の縦横（見出しから読むだけ。デコードはしない）。読めなければ null。
 * `sips -Z` は小さい画像を**引き伸ばす**ので、長辺が目標以下なら縮めない（#593 のレビュー）
 */
export function imageSize(b: Buffer, type: IconType): { width: number; height: number } | null {
  try {
    if (type === 'png') return b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null
    if (type === 'gif') return b.length >= 10 ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : null
    if (type === 'webp') {
      const kind = b.toString('ascii', 12, 16)
      if (kind === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
      if (kind === 'VP8L') {
        const v = b.readUInt32LE(21)
        return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }
      }
      if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
      return null
    }
    // JPEG: SOF0〜SOF15（DHT・JPG・DAC を除く）の縦横
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]!
      if (marker === 0xff) {
        i++
        continue
      }
      const len = b.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
      i += 2 + len
    }
    return null
  } catch {
    return null
  }
}

/**
 * 軽い版の長辺の目標。ふつうは `base`、帯は短辺が `THUMB_BAND_SHORT` になる長辺（`base` 以上・`THUMB_BAND_EDGE_MAX` 以下）。
 * 大きさが読めなければ `base`
 */
export function thumbTarget(size: { width: number; height: number } | null, base: number): number {
  if (!size || !isBandImage(size.width, size.height)) return base
  return Math.max(base, Math.min(THUMB_BAND_EDGE_MAX, Math.round((size.width / size.height) * THUMB_BAND_SHORT)))
}

export class Thumbnails implements ThumbMaker {
  private readonly dir: string
  private readonly shrink: Shrinker
  /** 同じ中身を同時に 2 回縮めない */
  private readonly inflight = new Map<string, Promise<ThumbResult>>()
  private running = 0
  private readonly waiting: (() => void)[] = []
  /** `sips` が見つからなかった（Linux など）。以後は呼ばない */
  private missing = false
  private made = 0
  /** 縮められなかった中身 → 覚えた時刻 */
  private readonly failed = new Map<string, number>()
  private readonly now: () => number

  constructor(dir: string, shrink: Shrinker = sipsShrink, now: () => number = Date.now) {
    this.dir = dir
    this.shrink = shrink
    this.now = now
  }

  async thumb(img: { bytes: Buffer; type: IconType }): Promise<ThumbResult> {
    if (img.bytes.length < THUMB_MIN_BYTES) return { kind: 'original' }
    const format: ThumbFormat = hasAlpha(img.bytes, img.type) ? 'png' : 'jpeg'
    const base = format === 'jpeg' ? THUMB_EDGE : THUMB_EDGE_ALPHA
    const size = imageSize(img.bytes, img.type)
    const target = thumbTarget(size, base)
    const longest = size ? Math.max(size.width, size.height) : 0
    // 目標より小さい画像は引き伸ばさない。PNG は縮めずに作り直しても軽くならないので元のまま、JPEG は大きさを変えずに作り直す
    if (longest > 0 && longest <= target && format === 'png') return { kind: 'original' }
    const edge = longest > 0 ? Math.min(target, longest) : target
    const hash = createHash('sha256').update(img.bytes).digest('hex').slice(0, 32)
    // 帯は長辺が違うので名前を分ける（前に長辺 512px で作った帯の軽い版を返さない。#709）
    const out = join(this.dir, `${hash}${target === base ? '' : `-${target}`}.${format === 'jpeg' ? 'jpg' : 'png'}`)
    try {
      return this.result(await readFile(out), format, img.bytes.length)
    } catch {
      // まだ無い
    }
    if (this.missing) return { kind: 'unavailable' }
    const failedAt = this.failed.get(hash)
    if (failedAt !== undefined && this.now() - failedAt < THUMB_FAILED_TTL_MS) return { kind: 'unavailable' }
    const pending = this.inflight.get(out)
    if (pending) return pending
    const job = this.make(img.bytes, hash, out, format, edge).finally(() => this.inflight.delete(out))
    this.inflight.set(out, job)
    return job
  }

  /** 縮めても元より重ければ元を返す（小さな画面のスクリーンショットの PNG など） */
  private result(bytes: Buffer, format: ThumbFormat, original: number): ThumbResult {
    return bytes.length > 0 && bytes.length < original ? { kind: 'thumb', bytes, type: format } : { kind: 'original' }
  }

  private async make(bytes: Buffer, hash: string, out: string, format: ThumbFormat, edge: number): Promise<ThumbResult> {
    await this.acquire()
    const src = join(this.dir, `${hash}.src`)
    const tmp = join(this.dir, `${hash}.tmp.${format === 'jpeg' ? 'jpg' : 'png'}`)
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(src, bytes)
      await this.shrink(src, tmp, format, edge)
      const made = await readFile(tmp)
      await rename(tmp, out)
      if (++this.made % 50 === 1) void this.trim()
      return this.result(made, format, bytes.length)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && (err as { path?: string }).path === 'sips') this.missing = true
      if (this.failed.size > 1000) this.failed.clear()
      this.failed.set(hash, this.now())
      return { kind: 'unavailable' }
    } finally {
      await Promise.all([rm(src, { force: true }), rm(tmp, { force: true })])
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.running < THUMB_CONCURRENCY) {
      this.running++
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.running--
  }

  /** 置き場が THUMB_KEEP を超えたら古いもの（mtime）から捨てる。失敗しても黙って諦める */
  private async trim(): Promise<void> {
    try {
      const names = (await readdir(this.dir)).filter((n) => /^[0-9a-f]{32}(-\d+)?\.(jpg|png)$/.test(n))
      if (names.length <= THUMB_KEEP) return
      const aged = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(this.dir, n))).mtimeMs })))
      aged.sort((a, b) => a.t - b.t)
      await Promise.all(aged.slice(0, aged.length - THUMB_KEEP).map(({ n }) => unlink(join(this.dir, n)).catch(() => {})))
    } catch {
      // 置き場が読めなければ何もしない
    }
  }
}
