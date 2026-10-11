// 日付ファイルの読み込みとキャッシュ。(mtime, size) で覚えて、変わっていなければ再パースしない。
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { FeedRow, SessionSummary } from '../../shared/types.ts'
import { aggregate, recentDates } from './aggregate.ts'

interface CachedFile {
  mtimeMs: number
  size: number
  rows: FeedRow[]
}

type Signature = [name: string, mtimeMs: number, size: number][]

/** 1 回の読み（日付の組ぶん）。`key` は読んだときの署名、`rev` はそのハッシュ */
interface Read {
  key: string
  rev: string
  rows: FeedRow[]
}

export function rev(signature: Signature): string {
  return createHash('sha1').update(JSON.stringify(signature)).digest('hex').slice(0, 12)
}

/** `YYYY-MM-DD.jsonl` と、マシンごとに分けた `YYYY-MM-DD.<host>.jsonl`（#113） */
const FEED_FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.(.+))?\.jsonl$/

/**
 * 置き場のファイル名から、その日付ぶんを読む順に並べて返す（#113）。
 *
 * 記録側が書く host は `[A-Za-z0-9_-]` だけだが、読む側はゆるく受ける（手で置いたものも読めるように）。
 * 並びは **日付 → host 名**（host 無しが先）で固定する。同じ `ts` の行の前後は読んだ順で決まるので、
 * ここが `readdir` の順（OS 任せ）のままだとマシンによって画面の並びが変わってしまう
 */
export function feedFiles(names: readonly string[], dates: readonly string[]): string[] {
  const byDate = new Map<string, { host: string; name: string }[]>()
  for (const name of names) {
    const m = FEED_FILE_RE.exec(name)
    if (!m) continue
    const found = byDate.get(m[1]!)
    if (found) found.push({ host: m[2] ?? '', name })
    else byDate.set(m[1]!, [{ host: m[2] ?? '', name }])
  }
  const out: string[] = []
  for (const date of dates) {
    const found = byDate.get(date)
    if (!found) continue
    found.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0))
    for (const f of found) out.push(f.name)
  }
  return out
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
  /** 日付の組 → 最後に組んだ行（#765 のレビュー。署名が同じ間は、ファイルごとの行を繋ぎ直して並べ直さない） */
  private rowsCache = new Map<string, Read>()
  /** いま読んでいる途中のもの（#765）。同じ鍵で同時に来た呼び出しは、この 1 つを待つ */
  private pending = new Map<string, Promise<unknown>>()

  readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  /**
   * 読むファイル名（#113）。1台なら日付ぶんの1つだが、複数マシンの記録を集めていれば
   * 同じ日に `<host>` 違いが並ぶので、`readdir` して拾う（日付から組み立てると別マシンのぶんが落ちる）
   */
  private async names(dates: readonly string[]): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.directory)
    } catch {
      return [] // 置き場がまだ無い
    }
    return feedFiles(entries, dates)
  }

  /**
   * 同時に来た同じ読みを 1 回にまとめる（#765）。3 秒のポーリングはタブ・端末・MCP の数だけ来るので、サーバが遅れると
   * 同じ `days` の `stat` と集計が要求の数だけ並んで走り、さらに遅れる循環に入っていた。終わったら忘れる（次は読み直す）。
   * 待っている間に記録が伸びても、返すのは読み始めたときのもの（次のポーリングが拾う。キャッシュと同じ扱い）
   */
  private share<T>(key: string, make: () => Promise<T>): Promise<T> {
    const found = this.pending.get(key)
    if (found) return found as Promise<T>
    const p = make().finally(() => this.pending.delete(key))
    this.pending.set(key, p)
    return p
  }

  /** 窓のファイルの (name, mtime, size)。行を読まずに「変わったか」だけ見る（テスト用。集計は `load()` が読んだときの署名を使う） */
  async signature(days: number): Promise<Signature> {
    const parts: Signature = []
    for (const name of await this.names(recentDates(days))) {
      try {
        const st = await stat(join(this.directory, name))
        parts.push([name, st.mtimeMs, st.size])
      } catch {
        // 読む直前に消えたぶんは飛ばす
      }
    }
    return parts
  }

  private async readFile(path: string): Promise<CachedFile | null> {
    let st
    try {
      st = await stat(path)
    } catch {
      this.files.delete(path)
      return null
    }
    const cached = this.files.get(path)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached
    let rows: FeedRow[] = []
    try {
      rows = parseRows(await readFile(path, 'utf-8'))
    } catch {
      rows = []
    }
    const entry = { mtimeMs: st.mtimeMs, size: st.size, rows }
    this.files.set(path, entry)
    return entry
  }

  /**
   * SAI が自分で回す子プロセス（一言を作る claude -p。server/digest/digest.ts）は、このディレクトリを cwd にして起動する。
   * フックの record.py が古くて AGENT_FEED_SKIP を知らないと、その子のターンが行として書かれてしまうので、
   * cwd がここ（かその下）の行は SAI 自身の雑音として読み飛ばす（自分の要約を自分でまた要約する、も防ぐ）
   */
  private isOwnNoise(row: FeedRow): boolean {
    const cwd = row.cwd ?? ''
    return cwd === this.directory || cwd.startsWith(this.directory + sep)
  }

  /** `async` にしない（同時の呼び出しが同じ Promise を受け取れるように。#765） */
  rows(days: number): Promise<FeedRow[]> {
    return this.rowsOn(recentDates(days))
  }

  /** その日付（`YYYY-MM-DD`）ぶんの行。記録を調べる道具（`server/tools/feedRead.ts`。#703）が日付の範囲で読む */
  rowsOn(dates: readonly string[]): Promise<FeedRow[]> {
    const key = dates.join(',')
    return this.share(`rows:${key}`, () => this.load(dates).then((r) => r.rows))
  }

  /**
   * 行と、読んだときの署名を一緒に返す（#765 のレビュー）。集計の鍵は**この読みが stat した値**から作る。署名を別に取ってから
   * 行を読むと、読みかけの古い読み（別の要求のもの）に相乗りして、古い行の集計を新しい署名で覚えてしまう
   * （その後ファイルが変わるまで、rev は新しいのに中身は古いまま）
   */
  private load(dates: readonly string[]): Promise<Read> {
    return this.share(`read:${dates.join(',')}`, () => this.readRowsOn(dates))
  }

  private async readRowsOn(dates: readonly string[]): Promise<Read> {
    const key = dates.join(',')
    const signature: Signature = []
    const parts: FeedRow[][] = []
    for (const name of await this.names(dates)) {
      const file = await this.readFile(join(this.directory, name))
      if (!file) continue
      signature.push([name, file.mtimeMs, file.size])
      parts.push(file.rows)
    }
    const sig = JSON.stringify(signature)
    const cached = this.rowsCache.get(key)
    if (cached && cached.key === sig) return cached
    const rows: FeedRow[] = []
    for (const part of parts) for (const r of part) if (!this.isOwnNoise(r)) rows.push(r)
    // 別マシンのファイルは日付ごとに丸ごと後ろに付くので、ここで ts に並べ直す（sort は安定なので同じ ts は読んだ順）
    rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    const read: Read = { key: sig, rev: rev(signature), rows }
    this.rowsCache.set(key, read)
    return read
  }

  /** セッション一覧。days ごとに最新の1つだけキャッシュする。同時に来たぶんは 1 回の集計を待つ（#765） */
  sessions(days: number): Promise<{ rev: string; sessions: SessionSummary[] }> {
    return this.share(`sessions:${days}`, () => this.readSessions(days))
  }

  private async readSessions(days: number): Promise<{ rev: string; sessions: SessionSummary[] }> {
    const read = await this.load(recentDates(days))
    const cached = this.sessionsCache.get(days)
    if (cached && cached.key === read.key) return { rev: cached.rev, sessions: cached.sessions }
    const sessions = aggregate(read.rows)
    const entry = { key: read.key, rev: read.rev, sessions }
    this.sessionsCache.set(days, entry)
    return { rev: entry.rev, sessions }
  }
}
