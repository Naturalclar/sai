// 添付の原本に寿命を付ける（#792）。
//
// `~/.agent-feed/attachments/` には掃除が無く、iPhone の写真 1 枚で 5MB、食事の写真を 1 日 3 枚で年 5.8GB 積まれる。
// 人が決めたこと: **原本は 30 日で消す。軽い版は永久に残す**（`AttachmentStore.keepThumb()` の置き場。`thumbs/` の LRU には相乗りしない）。
//
// 消す条件（全部そろったときだけ）:
// - `attachments/<dir>/` 直下の、SAI が作った形の名前の**画像**（文字のファイル・PDF は軽い版が無いので消さない）
// - `THUMB_MIN_BYTES` 以上（小さい原本は縮める意味が無く、残す方が安い）
// - 最後に書いた時刻（mtime）が寿命より古い（#791 の一括処理で EXIF を落とし直した原本は、その時刻から数え直す）
// - 捨てない軽い版が置いてある。無ければこの場で作り、作れなければ（`sips` が無い・失敗・縮めても小さくならない）**消さない**
//
// 消したあとも、配る口（`GET /api/attachments/<dir>/<name>`）が軽い版を返すので、過去の行とギャラリーの画像は出続ける。
//
// 増え方を見えるようにする（これが本体。問題は容量そのものではなく、誰も見ていなかったこと）:
// - 1 回ごとに `<feed dir>/attachments.log` へ 1 行（JSON）。消すものが無かった回も書く（「掃除が動いていない」と区別する）
// - 置き場の合計が `WARN_BYTES` を超えていれば `over()` が返し、画面がバナーを出す
import { appendFile, readFile } from 'node:fs/promises'
import { THUMB_MIN_BYTES } from '../local/thumbnails.ts'
import type { ThumbMaker } from '../local/thumbnails.ts'
import { sniffImageType } from '../../shared/icon.ts'
import type { AttachmentStore } from './attachments.ts'

/** 寿命の既定（日） */
export const ATTACHMENT_TTL_DAYS = 30
/** 置き場の合計がこれを超えたら知らせる */
export const ATTACHMENT_WARN_BYTES = 500 * 1024 * 1024
/** 掃除の間隔 */
export const ATTACHMENT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface SweepResult {
  /** 走った時刻（ISO） */
  at: string
  /** 見た原本の数 */
  originals: number
  /** 消した数とバイト数 */
  deleted: number
  freed_bytes: number
  /** 寿命を過ぎていたが残したもの: 軽い版が無く作れなかった・小さい（しきい値未満）・消せなかった */
  kept_no_thumb: number
  kept_small: number
  failed: number
  /** この回で作った軽い版 */
  thumbs_made: number
  /** 置き場の合計（SAI が作った形の名前のファイルだけ。原本・軽い版・文字のファイル・PDF・元の名前） */
  total_bytes: number
  total_files: number
}

export interface SweepOptions {
  /** 寿命（ミリ秒）。0 以下なら消さない（計測とログだけ） */
  ttlMs: number
  /** これを超えたら知らせる */
  warnBytes?: number
  /** 1 行ずつ足すログ。無ければ書かない */
  logPath?: string
  now?: () => number
}

export class AttachmentSweeper {
  private readonly store: AttachmentStore
  private readonly thumbs: ThumbMaker
  private readonly ttlMs: number
  private readonly warnBytes: number
  private readonly logPath: string | undefined
  private readonly now: () => number
  private lastResult: SweepResult | null = null
  private running: Promise<SweepResult> | null = null
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(store: AttachmentStore, thumbs: ThumbMaker, opts: SweepOptions) {
    this.store = store
    this.thumbs = thumbs
    this.ttlMs = opts.ttlMs
    this.warnBytes = opts.warnBytes ?? ATTACHMENT_WARN_BYTES
    this.logPath = opts.logPath
    this.now = opts.now ?? Date.now
  }

  /** 直近の結果（まだなら null） */
  last(): SweepResult | null {
    return this.lastResult
  }

  /** 置き場がしきい値を超えていれば、その大きさとしきい値（画面のバナー用）。超えていない・まだ測っていないなら null */
  over(): { bytes: number; threshold: number } | null {
    const r = this.lastResult
    return r && r.total_bytes > this.warnBytes ? { bytes: r.total_bytes, threshold: this.warnBytes } : null
  }

  /** 起動時に 1 回と、以後は間隔ごとに回す。タイマーはプロセスを引き留めない */
  start(intervalMs = ATTACHMENT_SWEEP_INTERVAL_MS, firstDelayMs = 0): void {
    this.stop()
    const tick = () => void this.run().catch(() => {})
    const first = setTimeout(tick, firstDelayMs)
    first.unref()
    this.timer = setInterval(tick, intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 1 回回す。同時に 2 回は回さない（走っていればその結果を待つ） */
  run(): Promise<SweepResult> {
    if (this.running) return this.running
    this.running = this.sweep().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async sweep(): Promise<SweepResult> {
    await this.store.ready()
    const now = this.now()
    const r: SweepResult = { at: new Date(now).toISOString(), originals: 0, deleted: 0, freed_bytes: 0, kept_no_thumb: 0, kept_small: 0, failed: 0, thumbs_made: 0, total_bytes: 0, total_files: 0 }
    const files = await this.store.walk()
    const thumbs = new Set(files.filter((f) => f.kind === 'thumb').map((f) => `${f.dir}/${f.name.slice(0, 16)}`))
    for (const f of files) {
      r.total_bytes += f.size
      r.total_files++
      if (f.kind !== 'original') continue
      r.originals++
      if (this.ttlMs <= 0 || now - f.mtimeMs < this.ttlMs) continue
      if (f.size < THUMB_MIN_BYTES) {
        r.kept_small++
        continue
      }
      if (!thumbs.has(`${f.dir}/${f.name.slice(0, 16)}`)) {
        // 軽い版がまだ無い（一度も枠に出していない）。ここで作る。作れなければ原本を残す（消すと画像が完全に失われる）
        if (!(await this.makeThumb(f.dir, f.name, f.path))) {
          r.kept_no_thumb++
          continue
        }
        r.thumbs_made++
      }
      if (await this.store.removeOriginal(f.dir, f.name)) {
        r.deleted++
        r.freed_bytes += f.size
        r.total_bytes -= f.size
        r.total_files--
      } else {
        r.failed++
      }
    }
    this.lastResult = r
    await this.log(r)
    return r
  }

  private async makeThumb(dir: string, name: string, path: string): Promise<boolean> {
    let bytes: Buffer
    try {
      bytes = await readFile(path)
    } catch {
      return false
    }
    const type = sniffImageType(bytes)
    if (!type) return false
    const t = await this.thumbs.thumb({ bytes, type })
    if (t.kind !== 'thumb') return false
    return (await this.store.keepThumb(dir, name, t.bytes, t.type === 'png' ? 'png' : 'jpeg')) !== null
  }

  private async log(r: SweepResult): Promise<void> {
    if (!this.logPath) return
    try {
      await appendFile(this.logPath, `${JSON.stringify({ ...r, ttl_days: Math.round(this.ttlMs / 86_400_000), warn_bytes: this.warnBytes })}\n`, 'utf-8')
    } catch {
      // ログが書けなくても掃除は済んでいる
    }
  }
}
