// 自分（人）の表示名。~/.agent-feed/profile.json に { "name": "..." } で持つ（アイコンは icons.ts の IconStore に固定の鍵で）。
// MetaStore と同じく (mtime, size) で覚えて変わらなければ読み直さず、tmp に書いて rename する
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mergeProfile } from '../shared/profile.ts'

export const PROFILE_FILE = 'profile.json'

interface Cached {
  mtimeMs: number
  size: number
  name: string | undefined
}

export class ProfileStore {
  readonly path: string
  private cache: Cached | null = null

  constructor(path: string) {
    this.path = path
  }

  /** 表示名。ファイルが無ければ undefined。rev はファイルの (mtime, size) で、変われば応答の rev も変わる。無ければ '' */
  async get(): Promise<{ rev: string; name: string | undefined }> {
    let st
    try {
      st = await stat(this.path)
    } catch {
      this.cache = null
      return { rev: '', name: undefined }
    }
    const rev = `${st.mtimeMs}:${st.size}`
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return { rev, name: this.cache.name }
    let name: string | undefined
    try {
      const obj = JSON.parse(await readFile(this.path, 'utf-8')) as unknown
      // 壊れた値は捨てる（検査はセッションの表示名と同じ）
      const { name: checked, error } = mergeProfile({}, obj)
      if (!error) name = checked
    } catch {
      name = undefined // 壊れていたら無い扱い。次の set で書き直される
    }
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, name }
    return { rev, name }
  }

  /** 表示名を置く。undefined なら消す（ファイルは空のオブジェクトで残す） */
  async set(name: string | undefined): Promise<string | undefined> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(name ? { name } : {}, null, 2) + '\n', 'utf-8')
    await rename(tmp, this.path)
    this.cache = null
    return name
  }
}
