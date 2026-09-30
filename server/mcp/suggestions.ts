// Manager が宛先のセッションの入力欄に置いた「案」（#565）。~/.agent-feed/suggestions.json に { <エンティティ ID>: ManagerDraft } で持つ。
// **1 セッションに 1 つ**で、新しく置くと前のものを上書きする。出すかどうか（24 時間・人の入力が後に来たか）は
// `shared/managerDraft.ts` の `liveManagerDraft()` が読むときに決めるので、ここは置く・取る・読むだけ。
// ReadStore と同じく (mtime, size) で覚えて変わらなければ読み直さず、tmp に書いて rename する
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { MANAGER_DRAFT_TTL_MS } from '../../shared/managerDraft.ts'
import type { ManagerDraft } from '../../shared/types.ts'

export const SUGGESTIONS_FILE = 'suggestions.json'

/** 覚えておく宛先の数の上限。古いものから捨てる */
export const SUGGESTIONS_MAX = 500

function parse(text: string): Record<string, ManagerDraft> {
  const obj = JSON.parse(text) as unknown
  const out: Record<string, ManagerDraft> = {}
  if (!obj || typeof obj !== 'object') return out
  for (const [id, v] of Object.entries(obj as Record<string, unknown>)) {
    const d = v as Partial<ManagerDraft> | null
    if (d && typeof d.text === 'string' && typeof d.from === 'string' && typeof d.at === 'number' && Number.isFinite(d.at)) {
      out[id] = { text: d.text, from: d.from, at: d.at, base_text: typeof d.base_text === 'string' ? d.base_text : '', base_turns: typeof d.base_turns === 'number' ? d.base_turns : 0, busy: d.busy === true }
    }
  }
  return out
}

export class SuggestionStore {
  readonly path: string
  private readonly now: () => number
  private cache: { mtimeMs: number; size: number; entries: Record<string, ManagerDraft> } | null = null
  // 書き込みを 1 本ずつにする（置くと捨てるが続けて来ても、片方が消えないように）
  private chain: Promise<unknown> = Promise.resolve()

  constructor(path: string, now: () => number = Date.now) {
    this.path = path
    this.now = now
  }

  /** いま置いてあるもの（古い・人の入力が後に来たものも含む。出すかは読む側が決める）。ファイルが無い・壊れていれば空 */
  async all(): Promise<Record<string, ManagerDraft>> {
    let st
    try {
      st = await stat(this.path)
    } catch {
      return {}
    }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.entries
    let entries: Record<string, ManagerDraft> = {}
    try {
      entries = parse(await readFile(this.path, 'utf-8'))
    } catch {
      entries = {}
    }
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, entries }
    return entries
  }

  /** 置く（前のものは上書き）。ついでに 24 時間を過ぎたものと上限を超えたものを捨てる。置いたものを返す */
  async put(id: string, text: string, from: string, base: Pick<ManagerDraft, 'base_text' | 'base_turns' | 'busy'>): Promise<ManagerDraft> {
    return this.serial(async () => {
      const now = this.now()
      const entries = Object.fromEntries(Object.entries(await this.all()).filter(([key, d]) => key !== id && now - d.at < MANAGER_DRAFT_TTL_MS))
      const draft: ManagerDraft = { text, from, at: now, ...base }
      entries[id] = draft // 置き直したものを一番新しい扱いにする（上限で捨てる順）
      const ids = Object.keys(entries)
      for (const old of ids.slice(0, Math.max(0, ids.length - SUGGESTIONS_MAX))) delete entries[old]
      await this.write(entries)
      return draft
    })
  }

  /** 取り除く（捨てた・入力欄に入れた）。`at` を渡したら、そのとき置いてあったものと同じときだけ（間に置き直された新しい案を消さない）。取り除いたものを返す */
  async take(id: string, at?: number): Promise<ManagerDraft | undefined> {
    return this.serial(async () => {
      const entries = { ...(await this.all()) }
      const draft = entries[id]
      if (!draft || (at !== undefined && draft.at !== at)) return undefined
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

  private async write(entries: Record<string, ManagerDraft>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    // tmp は書くたびに別の名前にする（同じ名前だと、重なった書き込みの片方の rename が ENOENT で落ちる）
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(entries) + '\n', 'utf-8')
    await rename(tmp, this.path)
    this.cache = null
  }
}
