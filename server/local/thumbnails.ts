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
/** `sips` 1 回の締切 */
export const THUMB_TIMEOUT_MS = 15_000
/** 同時に回す `sips` の数 */
export const THUMB_CONCURRENCY = 2
/** 置き場に残す軽い版の数。超えたら古いものから捨てる（1 枚 30〜80KB なので 1000 枚で 50MB 前後） */
export const THUMB_KEEP = 1000

export type ThumbFormat = 'jpeg' | 'png'

/** 縮める口。`input` の長辺を縮めて `format` で `output` に書く。テストは偽物を渡す */
export type Shrinker = (input: string, output: string, format: ThumbFormat) => Promise<void>

/** 本物の縮める口。`sips` の形は決め打ち（渡すのはここで書いたファイルのパスだけ） */
export const sipsShrink: Shrinker = (input, output, format) =>
  new Promise((resolve, reject) => {
    const args = ['-s', 'format', format, ...(format === 'jpeg' ? ['-s', 'formatOptions', String(THUMB_QUALITY)] : []), '-Z', String(format === 'jpeg' ? THUMB_EDGE : THUMB_EDGE_ALPHA), input, '--out', output]
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

  constructor(dir: string, shrink: Shrinker = sipsShrink) {
    this.dir = dir
    this.shrink = shrink
  }

  async thumb(img: { bytes: Buffer; type: IconType }): Promise<ThumbResult> {
    if (img.bytes.length < THUMB_MIN_BYTES) return { kind: 'original' }
    const format: ThumbFormat = hasAlpha(img.bytes, img.type) ? 'png' : 'jpeg'
    const hash = createHash('sha256').update(img.bytes).digest('hex').slice(0, 32)
    const out = join(this.dir, `${hash}.${format === 'jpeg' ? 'jpg' : 'png'}`)
    try {
      return this.result(await readFile(out), format, img.bytes.length)
    } catch {
      // まだ無い
    }
    if (this.missing) return { kind: 'unavailable' }
    const pending = this.inflight.get(out)
    if (pending) return pending
    const job = this.make(img.bytes, hash, out, format).finally(() => this.inflight.delete(out))
    this.inflight.set(out, job)
    return job
  }

  /** 縮めても元より重ければ元を返す（小さな画面のスクリーンショットの PNG など） */
  private result(bytes: Buffer, format: ThumbFormat, original: number): ThumbResult {
    return bytes.length > 0 && bytes.length < original ? { kind: 'thumb', bytes, type: format } : { kind: 'original' }
  }

  private async make(bytes: Buffer, hash: string, out: string, format: ThumbFormat): Promise<ThumbResult> {
    await this.acquire()
    const src = join(this.dir, `${hash}.src`)
    const tmp = join(this.dir, `${hash}.tmp.${format === 'jpeg' ? 'jpg' : 'png'}`)
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(src, bytes)
      await this.shrink(src, tmp, format)
      const made = await readFile(tmp)
      await rename(tmp, out)
      if (++this.made % 50 === 1) void this.trim()
      return this.result(made, format, bytes.length)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && (err as { path?: string }).path === 'sips') this.missing = true
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
      const names = (await readdir(this.dir)).filter((n) => /^[0-9a-f]{32}\.(jpg|png)$/.test(n))
      if (names.length <= THUMB_KEEP) return
      const aged = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(this.dir, n))).mtimeMs })))
      aged.sort((a, b) => a.t - b.t)
      await Promise.all(aged.slice(0, aged.length - THUMB_KEEP).map(({ n }) => unlink(join(this.dir, n)).catch(() => {})))
    } catch {
      // 置き場が読めなければ何もしない
    }
  }
}
