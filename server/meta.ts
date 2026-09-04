// セッションごとの表示名・アーカイブ。JSONL（記録側）は触らず、同じディレクトリの session-meta.json に別で持つ。
// 形は { "<エンティティID>": { "name": "...", "archived_at": "..." }, ... }。アイコン画像はファイルで別（icons.ts）。(mtime, size) で覚えて変わらなければ再パースしない。
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isEmptyMeta, normalizeMeta } from '../shared/meta.ts'
import type { SessionMeta } from '../shared/types.ts'

export const META_FILE = 'session-meta.json'

export type MetaMap = Record<string, SessionMeta>

interface Cached {
  mtimeMs: number
  size: number
  entries: MetaMap
}

/** 壊れた値や知らないキーを落として、正規化済みの entries だけ残す */
function sanitize(obj: unknown): MetaMap {
  const out: MetaMap = {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out
  for (const [id, value] of Object.entries(obj as Record<string, unknown>)) {
    const { meta, error } = normalizeMeta(value)
    if (!error && !isEmptyMeta(meta)) out[id] = meta
  }
  return out
}

export class MetaStore {
  readonly path: string
  private cache: Cached | null = null

  constructor(path: string) {
    this.path = path
  }

  /** 全部。ファイルが無ければ空。rev はファイルの (mtime, size) で、変わればセッション一覧の rev も変わる */
  async all(): Promise<{ rev: string; entries: MetaMap }> {
    let st
    try {
      st = await stat(this.path)
    } catch {
      this.cache = null
      return { rev: '', entries: {} }
    }
    const rev = `${st.mtimeMs}:${st.size}`
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return { rev, entries: this.cache.entries }
    let entries: MetaMap = {}
    try {
      entries = sanitize(JSON.parse(await readFile(this.path, 'utf-8')))
    } catch {
      entries = {} // 壊れていたら空扱い。次の set で書き直される
    }
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, entries }
    return { rev, entries }
  }

  async get(id: string): Promise<SessionMeta | undefined> {
    return (await this.all()).entries[id]
  }

  /**
   * 1件を置き換える。空なら消す。tmp に書いて rename するので、途中で落ちても壊れたファイルは残らない。
   * 返り値は保存後の値（消したら undefined）
   */
  async set(id: string, meta: SessionMeta): Promise<SessionMeta | undefined> {
    const { entries } = await this.all()
    const next: MetaMap = { ...entries }
    if (isEmptyMeta(meta)) delete next[id]
    else next[id] = meta
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8')
    await rename(tmp, this.path)
    this.cache = null
    return next[id]
  }
}
