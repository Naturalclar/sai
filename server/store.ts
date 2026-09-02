// 日付ファイルの読み込みとキャッシュ。(mtime, size) で覚えて、変わっていなければ再パースしない。
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FeedRow, SessionSummary } from '../shared/types.ts'
import { aggregate, recentDates } from './aggregate.ts'

interface CachedFile {
  mtimeMs: number
  size: number
  rows: FeedRow[]
}

type Signature = [name: string, mtimeMs: number, size: number][]

export function rev(signature: Signature): string {
  return createHash('sha1').update(JSON.stringify(signature)).digest('hex').slice(0, 12)
}

export function parseRows(text: string): FeedRow[] {
  const rows: FeedRow[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let obj: unknown
    try {
      obj = JSON.parse(t)
    } catch {
      continue // 壊れた行は落とす
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && (obj as FeedRow).ts) rows.push(obj as FeedRow)
  }
  return rows
}

export class FeedStore {
  private files = new Map<string, CachedFile>()
  private sessionsCache = new Map<number, { key: string; rev: string; sessions: SessionSummary[] }>()

  readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  private paths(days: number): string[] {
    return recentDates(days).map((d) => join(this.directory, `${d}.jsonl`))
  }

  async signature(days: number): Promise<Signature> {
    const parts: Signature = []
    for (const path of this.paths(days)) {
      try {
        const st = await stat(path)
        parts.push([path.slice(this.directory.length + 1), st.mtimeMs, st.size])
      } catch {
        // 無い日は飛ばす
      }
    }
    return parts
  }

  private async readFile(path: string): Promise<FeedRow[]> {
    let st
    try {
      st = await stat(path)
    } catch {
      this.files.delete(path)
      return []
    }
    const cached = this.files.get(path)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.rows
    let rows: FeedRow[] = []
    try {
      rows = parseRows(await readFile(path, 'utf-8'))
    } catch {
      rows = []
    }
    this.files.set(path, { mtimeMs: st.mtimeMs, size: st.size, rows })
    return rows
  }

  async rows(days: number): Promise<FeedRow[]> {
    const rows: FeedRow[] = []
    for (const path of this.paths(days)) rows.push(...(await this.readFile(path)))
    rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    return rows
  }

  /** セッション一覧。days ごとに最新の1つだけキャッシュする */
  async sessions(days: number): Promise<{ rev: string; sessions: SessionSummary[] }> {
    const signature = await this.signature(days)
    const key = JSON.stringify(signature)
    const cached = this.sessionsCache.get(days)
    if (cached && cached.key === key) return { rev: cached.rev, sessions: cached.sessions }
    const sessions = aggregate(await this.rows(days))
    const entry = { key, rev: rev(signature), sessions }
    this.sessionsCache.set(days, entry)
    return { rev: entry.rev, sessions }
  }
}
