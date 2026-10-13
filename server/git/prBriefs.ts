// PR 1 本の要約（#790）を覚える。`~/.agent-feed/pr-summaries.json` に PR ごと 1 つ（作り直したら置き換える）。
//
// - **派生データ**。消しても記録（JSONL）は壊れず、次に押したときに作り直すだけ
// - 一言（`digest.jsonl`・「変？」）とは別の置き場で、混ぜない
// - GitHub には書かない（置くのは手元だけ）
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { PrBrief } from '../../shared/types.ts'

export const PR_BRIEFS_FILE = 'pr-summaries.json'
/** 覚える PR の数の上限。超えたら作った時刻の古いものから落とす */
export const PR_BRIEFS_MAX = 200

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** ファイルから読んだ 1 件を確かめる。形が違えば null（壊れた・手で書き換えたものを画面に渡さない） */
export function briefFrom(v: unknown): PrBrief | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const text = str(o.text)
  const head_sha = str(o.head_sha)
  if (!text || !head_sha) return null
  return {
    text,
    head_sha,
    at: str(o.at),
    comments: typeof o.comments === 'number' && Number.isFinite(o.comments) ? o.comments : 0,
    notes: Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === 'string') : [],
    via: str(o.via),
  }
}

/** 鍵。リポジトリは大文字小文字を区別しない（GitHub と同じ） */
export const briefKey = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`

export class PrBriefStore {
  readonly path: string
  private entries: Map<string, PrBrief> | null = null
  /** 書き込みは 1 本ずつ（同時に 2 つ作り終えても、片方を落とさない） */
  private writing: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  private async load(): Promise<Map<string, PrBrief>> {
    if (this.entries) return this.entries
    const entries = new Map<string, PrBrief>()
    try {
      const obj: unknown = JSON.parse(await readFile(this.path, 'utf-8'))
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [key, v] of Object.entries(obj)) {
          const brief = briefFrom(v)
          if (brief) entries.set(key, brief)
        }
      }
    } catch {
      // 無い・壊れているなら空から
    }
    // 読んでいる間に別の呼び出しが先に入れていれば、そちらを使う
    this.entries ??= entries
    return this.entries
  }

  async get(repo: string, number: number): Promise<PrBrief | undefined> {
    return (await this.load()).get(briefKey(repo, number))
  }

  async set(repo: string, number: number, brief: PrBrief): Promise<void> {
    const entries = await this.load()
    const key = briefKey(repo, number)
    // 入れ直して、新しいものを後ろへ
    entries.delete(key)
    entries.set(key, brief)
    if (entries.size > PR_BRIEFS_MAX) {
      const old = [...entries].sort((a, b) => a[1].at.localeCompare(b[1].at)).slice(0, entries.size - PR_BRIEFS_MAX)
      for (const [k] of old) entries.delete(k)
    }
    const job = this.writing.then(async () => {
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(Object.fromEntries(entries), null, 2) + '\n', 'utf-8')
      await rename(tmp, this.path)
    })
    // 書けなくても次の書き込みは止めない
    this.writing = job.catch(() => {})
    await job
  }
}
