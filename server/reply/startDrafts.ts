// 新しい worktree と新しいセッションの案（#892。`sai_start`）の置き場。~/.agent-feed/start-drafts.json に { <置いたセッションの ID>: StartDraft } で持つ。
// **1 セッションに 1 つ**で、新しく置くと前のものを上書きする。出すかどうか（24 時間）は `shared/startDraft.ts` の `liveStartDraft()` が読むときに決める。
// `SuggestionStore`（#565）と同じく (mtime, size) で覚えて変わらなければ読み直さず、tmp に書いて rename する。**置くだけで git もプロセスも起こさない**
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { START_AGENTS, START_DRAFT_TTL_MS } from '../../shared/startDraft.ts'
import type { StartDraft } from '../../shared/types.ts'

export const START_DRAFTS_FILE = 'start-drafts.json'

/** 覚えておく置き手の数の上限。古いものから捨てる */
export const START_DRAFTS_MAX = 200

function parse(text: string): Record<string, StartDraft> {
  const obj = JSON.parse(text) as unknown
  const out: Record<string, StartDraft> = {}
  if (!obj || typeof obj !== 'object') return out
  for (const [id, v] of Object.entries(obj as Record<string, unknown>)) {
    const d = v as Partial<StartDraft> | null
    if (d && typeof d.name === 'string' && typeof d.text === 'string' && typeof d.at === 'number' && Number.isFinite(d.at) && START_AGENTS.includes(d.agent as StartDraft['agent'])) {
      out[id] = { name: d.name, agent: d.agent as StartDraft['agent'], text: d.text, at: d.at }
    }
  }
  return out
}

export class StartDraftStore {
  readonly path: string
  private readonly now: () => number
  private cache: { mtimeMs: number; size: number; entries: Record<string, StartDraft> } | null = null
  // 書き込みを 1 本ずつにする（置くと片付けるが続けて来ても、片方が消えないように）
  private chain: Promise<unknown> = Promise.resolve()

  constructor(path: string, now: () => number = Date.now) {
    this.path = path
    this.now = now
  }

  /** いま置いてあるもの（古いものも含む。出すかは読む側が決める）。ファイルが無い・壊れていれば空 */
  async all(): Promise<Record<string, StartDraft>> {
    let st
    try {
      st = await stat(this.path)
    } catch {
      return {}
    }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.entries
    let entries: Record<string, StartDraft> = {}
    try {
      entries = parse(await readFile(this.path, 'utf-8'))
    } catch {
      entries = {}
    }
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, entries }
    return entries
  }

  /** 置く（前のものは上書き）。ついでに古いものと上限を超えたものを捨てる。置いたものを返す */
  async put(id: string, draft: Omit<StartDraft, 'at'>): Promise<StartDraft> {
    return this.serial(async () => {
      const now = this.now()
      const entries = Object.fromEntries(Object.entries(await this.all()).filter(([key, d]) => key !== id && now - d.at < START_DRAFT_TTL_MS))
      const placed: StartDraft = { ...draft, at: now }
      entries[id] = placed // 置き直したものを一番新しい扱いにする（上限で捨てる順）
      const ids = Object.keys(entries)
      for (const old of ids.slice(0, Math.max(0, ids.length - START_DRAFTS_MAX))) delete entries[old]
      await this.write(entries)
      return placed
    })
  }

  /** 片付ける（始めた・捨てた）。`at` が置いてあるものと同じときだけ（間に置き直された新しい案を消さない）。片付けたものを返す */
  async take(id: string, at: number): Promise<StartDraft | undefined> {
    return this.serial(async () => {
      const entries = { ...(await this.all()) }
      const draft = entries[id]
      if (!draft || draft.at !== at) return undefined
      delete entries[id]
      await this.write(entries)
      return draft
    })
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async write(entries: Record<string, StartDraft>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(entries) + '\n', 'utf-8')
    await rename(tmp, this.path)
    this.cache = null
  }
}
