// dots で直接話した会話を取り込む（#878）。dots が `$TMPDIR/sai-dots/` に置いた JSON のファイルを、受信箱に足して消す。
//
// - dots はこのマシンでコマンドを動かせるが、`127.0.0.1` へは繋がらない（サンドボックス）。書けるのは利用者専用の `$TMPDIR` なので、そこで受け渡す
// - **外には何も出さない**（ネットワークの口を増やさない。ローカルのファイルを読むだけ）
// - 読むのは、利用者が持ち主で、ほかの人が書けないフォルダの中の、利用者が持ち主の普通のファイルだけ（シンボリックリンクは読まない）
// - 中身は dots が書いたデータ。文字として受信箱に入れるだけで、指示として読まない
// - 本物の置き場を組むのは `main.ts` だけ（`createApp` の既定は取り込まない）
import { createHash } from 'node:crypto'
import { open, readdir, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { DOTS_TEXT_MAX } from '../../shared/dots.ts'
import { TIME_ZONE } from '../../shared/entity.ts'
import type { DotsInbox } from './inbox.ts'

export const DOTS_DROP_DIR = 'sai-dots'
/** 見に行く間隔 */
export const DOTS_DROP_INTERVAL_MS = 5_000
/** 1 つのファイルの上限（本文 2 つが上限いっぱいでも収まる大きさ） */
export const DROP_FILE_MAX_BYTES = 256 * 1024
/** 1 回に取り込むファイルの数 */
export const DROP_MAX_FILES = 200
/** 会話の名前の上限（字） */
export const THREAD_MAX = 120

export interface DropResult {
  imported: number
  /** 読めない・形が違う・大きすぎるなどで捨てたもの */
  rejected: number
  /** 持ち主・種類が違うので触らずに残したもの */
  skipped: number
}

interface Exchange {
  thread?: string
  user_text: string
  reply_text: string
  at?: string
}

/** dots が書いた 1 件として読めるか。読めなければ理由 */
export function parseExchange(raw: unknown): Exchange | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'オブジェクトではない'
  const r = raw as Record<string, unknown>
  if (typeof r.user_text !== 'string' || !r.user_text.trim()) return 'user_text が無い'
  if (typeof r.reply_text !== 'string' || !r.reply_text.trim()) return 'reply_text が無い'
  if ([...r.user_text].length > DOTS_TEXT_MAX || [...r.reply_text].length > DOTS_TEXT_MAX) return '本文が長すぎる'
  const out: Exchange = { user_text: r.user_text.trim(), reply_text: r.reply_text.trim() }
  if (typeof r.thread === 'string' && r.thread.trim()) out.thread = [...r.thread.trim().replace(/\s+/g, ' ')].slice(0, THREAD_MAX).join('')
  if (typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at))) out.at = new Date(r.at).toISOString()
  return out
}

/** Asia/Tokyo の日付（`YYYY-MM-DD`） */
const day = (iso: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))

/** 会話の id: dots が付けた名前ごと。無ければ日ごと（SAI の画面から始めた会話の UUID とは形が違うので、続けて送れない） */
export function dropConversationId(thread: string | undefined, at: string): string {
  const key = thread ? `thread:${thread}` : `day:${day(at)}`
  return `drop-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
}

export class DotsDrop {
  readonly dir: string
  private readonly inbox: DotsInbox
  private readonly uid: number
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<DropResult> | null = null

  constructor(dir: string, inbox: DotsInbox, opts: { uid?: number } = {}) {
    this.dir = dir
    this.inbox = inbox
    this.uid = opts.uid ?? process.getuid?.() ?? -1
  }

  /** 1 回取り込む。同時に呼ばれたら同じ 1 回を待たせる */
  importOnce(): Promise<DropResult> {
    this.running ??= this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return
    void this.importOnce().catch(() => {})
    this.timer = setInterval(() => void this.importOnce().catch(() => {}), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async run(): Promise<DropResult> {
    const result: DropResult = { imported: 0, rejected: 0, skipped: 0 }
    // フォルダそのもの: 利用者が持ち主で、ほかの人が書けないこと（シンボリックリンクなら開かない）
    let dirHandle
    try {
      dirHandle = await open(this.dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    } catch {
      return result
    }
    try {
      const st = await dirHandle.stat()
      if (!st.isDirectory() || st.uid !== this.uid || (st.mode & 0o022) !== 0) return result
    } finally {
      await dirHandle.close()
    }
    let names: string[]
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith('.json')).sort()
    } catch {
      return result
    }
    const known = await this.inbox.ids()
    for (const name of names.slice(0, DROP_MAX_FILES)) {
      const path = join(this.dir, name)
      let text: string
      let mtime: Date
      // シンボリックリンクは開かない。開いたものが持ち主の普通のファイルかを、開いたあとで確かめる（確かめてから開くと差し替えられる）
      let fh
      try {
        fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      } catch {
        result.skipped++
        continue
      }
      try {
        const st = await fh.stat()
        if (!st.isFile() || st.uid !== this.uid) {
          result.skipped++
          continue
        }
        if (st.size > DROP_FILE_MAX_BYTES) {
          await unlink(path).catch(() => {})
          result.rejected++
          continue
        }
        text = await fh.readFile('utf-8')
        mtime = st.mtime
      } finally {
        await fh.close()
      }
      let parsed: Exchange | string
      try {
        parsed = parseExchange(JSON.parse(text))
      } catch {
        parsed = 'JSON ではない'
      }
      if (typeof parsed === 'string') {
        await unlink(path).catch(() => {})
        result.rejected++
        continue
      }
      const at = parsed.at ?? mtime.toISOString()
      // id は中身から（同じものを 2 回置かれても、消す前に落ちて読み直しても、重ならない）
      const id = `drop-${createHash('sha256').update(text).digest('hex').slice(0, 32)}`
      if (!known.has(`${id}-u`)) {
        await this.inbox.importExchange({ id, conversationId: dropConversationId(parsed.thread, at), at, ...(parsed.thread ? { thread: parsed.thread } : {}), userText: parsed.user_text, replyText: parsed.reply_text })
        known.add(`${id}-u`)
        result.imported++
      }
      await unlink(path).catch(() => {})
    }
    return result
  }
}
