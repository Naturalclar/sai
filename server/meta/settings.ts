// サーバ側の設定（一言コメントの入切・口・モデル・性格、Linear の workspace）。~/.agent-feed/settings.json。
// 一言はサーバが作るので設定もサーバに持つ（localStorage だと作る側が知らない）。
// 一言の入切・口・モデルは前は環境変数（SAI_DIGEST / SAI_DIGEST_PROVIDER / SAI_DIGEST_MODEL）で、サーバを立て直すたびに
// 打ち直していた（#288）。本文の送り先（SAI_DIGEST_URL）と鍵（SAI_DIGEST_API_KEY）は、画面から外へ向けられないよう環境変数のまま
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDigestModel, isDigestProvider } from '../../shared/digestSettings.ts'
import { DEFAULT_PERSONA, isPersonaId } from '../../shared/persona.ts'
import { isLinearWorkspace } from '../../shared/refs.ts'
import type { DigestProvider, PersonaId } from '../../shared/types.ts'

export const SETTINGS_FILE = 'settings.json'

export interface Settings {
  persona: PersonaId
  /** Linear の workspace。空なら設定なし */
  linear_workspace: string
  /** 一言コメントを作るか。既定はオフ（本文を LLM に送るので、入にしたときだけ） */
  digest: boolean
  /** 一言を作る口 */
  digest_provider: DigestProvider
  /** 一言を作るモデル。空なら口の既定（claude は haiku、openai は既定が無いので作らない） */
  digest_model: string
}

export class SettingsStore {
  readonly path: string
  private cache: Settings | null = null

  constructor(path: string) {
    this.path = path
  }

  /** 無ければ既定。壊れていても既定（次の set で書き直される）。読めないキーはそのキーだけ既定に落とす */
  async get(): Promise<Settings> {
    if (this.cache) return this.cache
    const settings: Settings = { persona: DEFAULT_PERSONA, linear_workspace: '', digest: false, digest_provider: 'claude', digest_model: '' }
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf-8')) as Record<string, unknown>
      if (isPersonaId(raw?.persona)) settings.persona = raw.persona
      if (isLinearWorkspace(raw?.linear_workspace)) settings.linear_workspace = raw.linear_workspace
      if (raw?.digest === true) settings.digest = true
      if (isDigestProvider(raw?.digest_provider)) settings.digest_provider = raw.digest_provider
      if (isDigestModel(raw?.digest_model)) settings.digest_model = raw.digest_model
    } catch {
      // 無い・壊れている
    }
    this.cache = settings
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
