// 処理中に送った返信を預かる（#305）。前のターンが終わったら app.ts の drain() が古い順に 1 件ずつ起動する。
//
// メモリだけだと、サーバの再起動（pnpm start:watch で server/ が変わった、など）で送ったつもりの指示が
// 黙って消える。replying.json（#100）と同じく ~/.agent-feed/reply-queue.json にも書き、起動時に読み戻す。
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { QueuedReply, ReplyQueueMap } from '../../shared/types.ts'

export const QUEUE_FILE = 'reply-queue.json'

/** 1 セッションに預かれる数。押し間違いで積み上がらないように（超えたら 409） */
export const QUEUE_MAX = 10

/** 預かった 1 件。画面に出す `QueuedReply` に、起動に要るものを足したもの（この 2 つは画面に出さない） */
export interface StoredReply extends QueuedReply {
  /** 添えた画像の絶対パス（預かる前に置き場で検査済み）。Codex / OpenCode はフラグでも渡す */
  attachments: string[]
  /**
   * 許可・質問を画面で答える MCP の宛先（このサーバ自身のループバック。`selfUrl()`）。
   * 起動するときには手元にリクエストが無いので、預かるときに覚えておく
   */
  url: string
  /** 別のセッションから送られたメッセージなら、その message_id（#310）。起動したターンから先へ送らせない（連鎖 1 段） */
  origin?: string
}

interface Queue {
  items: StoredReply[]
  /** 自動では回さない理由（前の返信が失敗した・起動できなかった）。無ければ回す */
  paused?: string
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** ファイルの 1 件を検査する。形が合わなければ null（壊れたファイルでサーバを落とさない） */
function storedFrom(v: unknown): StoredReply | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Partial<StoredReply>
  if (typeof r.queue_id !== 'string' || !r.queue_id || typeof r.text !== 'string' || !r.text || typeof r.since !== 'string') return null
  return {
    queue_id: r.queue_id,
    text: r.text,
    since: r.since,
    attachments: isStrings(r.attachments) ? r.attachments : [],
    url: typeof r.url === 'string' ? r.url : '',
    ...(typeof r.origin === 'string' && r.origin ? { origin: r.origin } : {}),
  }
}

export class ReplyQueueStore {
  private queues = new Map<string, Queue>()
  readonly path: string | null

  /** path があればそこにも書き、起動時に読み戻す。null ならメモリだけ */
  constructor(path: string | null) {
    this.path = path
    this.load()
  }

  private load(): void {
    if (!this.path) return
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf-8'))
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const q = value as { items?: unknown; paused?: unknown }
      const items = (Array.isArray(q.items) ? q.items : []).map(storedFrom).filter((x): x is StoredReply => x !== null)
      if (items.length === 0) continue
      this.queues.set(id, { items, ...(typeof q.paused === 'string' && q.paused ? { paused: q.paused } : {}) })
    }
  }

  /** いまの中身を書く。tmp → rename（replying.json と同じ）。書けなくても預かりはメモリで続く */
  private persist(): void {
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.queues), null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch {
      // 書けなくても預かりはメモリで続く
    }
  }

  /** 後ろに預ける。`QUEUE_MAX` を超えるなら預からずに null */
  add(id: string, text: string, attachments: readonly string[], url: string, now: Date = new Date(), origin: string = ''): StoredReply | null {
    const q = this.queues.get(id) ?? { items: [] }
    if (q.items.length >= QUEUE_MAX) return null
    const item: StoredReply = {
      queue_id: randomBytes(8).toString('hex'),
      text,
      since: now.toISOString(),
      attachments: [...attachments],
      url,
      ...(origin ? { origin } : {}),
    }
    q.items.push(item)
    this.queues.set(id, q)
    this.persist()
    return item
  }

  /** 次に回すもの。起動できるまでは外さない（起動できなければ残して止める） */
  peek(id: string): StoredReply | undefined {
    return this.queues.get(id)?.items[0]
  }

  size(id: string): number {
    return this.queues.get(id)?.items.length ?? 0
  }

  /** 起動できた先頭を外す。先頭がもう別のもの（起動している間に取り消された）なら何もしない */
  shift(id: string, queueId: string): boolean {
    const q = this.queues.get(id)
    if (!q || q.items[0]?.queue_id !== queueId) return false
    return this.remove(id, queueId)
  }

  /** 取り消す。空になったらそのセッションの預かりごと消す（止めていた理由も） */
  remove(id: string, queueId: string): boolean {
    const q = this.queues.get(id)
    const at = q ? q.items.findIndex((item) => item.queue_id === queueId) : -1
    if (!q || at < 0) return false
    q.items.splice(at, 1)
    if (q.items.length === 0) this.queues.delete(id)
    this.persist()
    return true
  }

  /**
   * 条件に合う預かりをまとめて取り消す。消した数を返す。
   * 人がセッション同士のメッセージの送信を止めたとき、そのセッションから送られて並んでいた分を消すのに使う（#311）
   */
  removeWhere(match: (id: string, item: StoredReply) => boolean): number {
    let removed = 0
    for (const [id, q] of [...this.queues]) {
      const keep = q.items.filter((item) => !match(id, item))
      if (keep.length === q.items.length) continue
      removed += q.items.length - keep.length
      if (keep.length === 0) this.queues.delete(id)
      else q.items = keep
    }
    if (removed > 0) this.persist()
    return removed
  }

  /** 自動で回すのを止める。預かりが無ければ何もしない（止める対象が無い） */
  pause(id: string, reason: string): void {
    const q = this.queues.get(id)
    if (!q || q.paused === reason) return
    q.paused = reason
    this.persist()
  }

  /** 止めていたら再開する。止めていなければ false */
  resume(id: string): boolean {
    const q = this.queues.get(id)
    if (!q?.paused) return false
    delete q.paused
    this.persist()
    return true
  }

  /** 止めている理由。止めていなければ空 */
  paused(id: string): string {
    return this.queues.get(id)?.paused ?? ''
  }

  /** 回す候補（預かりがあって止めていないセッション） */
  ids(): string[] {
    return [...this.queues].filter(([, q]) => q.items.length > 0 && !q.paused).map(([id]) => id)
  }

  /** 画面に出す形。添付の絶対パスと宛先は載せない（本文の末尾に添付のパスは足してある） */
  snapshot(): ReplyQueueMap {
    return Object.fromEntries(
      [...this.queues].map(([id, q]) => [
        id,
        { items: q.items.map(({ queue_id, text, since }) => ({ queue_id, text, since })), ...(q.paused ? { paused: q.paused } : {}) },
      ]),
    )
  }

  /** rev に混ぜる。預けた・回した・取り消した・止めた・再開した、のどれでも変わる */
  key(): string {
    return [...this.queues]
      .map(([id, q]) => `${id}:${q.paused ? 1 : 0}:${q.items.map((item) => item.queue_id).join(',')}`)
      .sort()
      .join('|')
  }
}
