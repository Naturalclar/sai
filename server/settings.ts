// サーバ側の設定（いまは一言コメントの性格だけ）。~/.agent-feed/settings.json。
// 一言はサーバが作るので性格もサーバに持つ（localStorage だと作る側が知らない）。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_PERSONA, isPersonaId } from '../shared/persona.ts'
import type { PersonaId } from '../shared/types.ts'

export const SETTINGS_FILE = 'settings.json'

export interface Settings {
  persona: PersonaId
}

export class SettingsStore {
  readonly path: string
  private cache: Settings | null = null

  constructor(path: string) {
    this.path = path
  }

  /** 無ければ既定。壊れていても既定（次の set で書き直される） */
  async get(): Promise<Settings> {
    if (this.cache) return this.cache
    let persona: PersonaId = DEFAULT_PERSONA
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf-8')) as { persona?: unknown }
      if (isPersonaId(raw?.persona)) persona = raw.persona
    } catch {
      // 無い・壊れている
    }
    this.cache = { persona }
    return this.cache
  }

  async set(next: Partial<Settings>): Promise<Settings> {
    const merged: Settings = { ...(await this.get()), ...next }
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
    await rename(tmp, this.path)
    this.cache = merged
    return merged
  }
}
