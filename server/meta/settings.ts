// サーバ側の設定（一言コメントの入切・口・モデル・性格、Linear の workspace）。~/.agent-feed/settings.json。
// 一言はサーバが作るので設定もサーバに持つ（localStorage だと作る側が知らない）。
// 一言の入切・口・モデルは前は環境変数（SAI_DIGEST / SAI_DIGEST_PROVIDER / SAI_DIGEST_MODEL）で、サーバを立て直すたびに
// 打ち直していた（#288）。本文の送り先（SAI_DIGEST_URL）と鍵（SAI_DIGEST_API_KEY）は、画面から外へ向けられないよう環境変数のまま
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDigestModel, isDigestProvider } from '../../shared/digestSettings.ts'
import { DEFAULT_PERSONA, isPersonaId } from '../../shared/persona.ts'
import { isJevAuto } from '../../shared/jev.ts'
import { isLinearWorkspace } from '../../shared/refs.ts'
import type { DigestProvider, PersonaId } from '../../shared/types.ts'

export const SETTINGS_FILE = 'settings.json'

export interface Settings {
  persona: PersonaId
  /** Linear の workspace。空なら設定なし */
  linear_workspace: string
  /** 一言コメントを作るか。既定はオフ（本文を LLM に送るので、入にしたときだけ） */
  digest: boolean
  /**
   * 次に送る文面の案を作るか（#560）。一言と同じ口・同じモデルで、一言とは別に入切する。
   * **無い（`undefined`）ときは `digest` に従う**（#560 より前は一言と一緒に動いていた。一言を入にしていた人の案を止めず、
   * 入にしていなかった人の本文を黙って LLM に送り始めない）。**読むときに埋めない**——埋めると、ほかの設定を
   * 保存した瞬間にその時点の値がファイルに固まり、以後は一言の入切に付いてこなくなる（#561 のレビュー）。
   * 人が「次に送る文面の案を作る」を押したときだけ書く
   */
  next_ask?: boolean
  /** 一言を作る口 */
  digest_provider: DigestProvider
  /** 一言を作るモデル。空なら口の既定（claude は haiku、openai は既定が無いので作らない） */
  digest_model: string
  /**
   * 許可を Jev で予想するか（#491）。**既定は入**（鍵 JEV_API_KEY が無ければ入でも何も送らないので、鍵を置いた人だけに効く）。
   * 切ったことだけを覚える（`false` を書く）
   */
  jev: boolean
  /**
   * Jev の確率がこれ以上なら自動で「常に許可」する（#499）。0 は「しない」（**既定**。外部のモデルの判断でツールを走らせるので、
   * 入にするのはその人）。それ以外は 0.5〜1（`isJevAuto()`）
   */
  jev_auto: number
}

/** 既定。テストもこれを使う（キーを足したらここ 1 か所） */
export const DEFAULT_SETTINGS: Settings = { persona: DEFAULT_PERSONA, linear_workspace: '', digest: false, digest_provider: 'claude', digest_model: '', jev: true, jev_auto: 0 }

export class SettingsStore {
  readonly path: string
  private cache: Settings | null = null

  constructor(path: string) {
    this.path = path
  }

  /** 無ければ既定。壊れていても既定（次の set で書き直される）。読めないキーはそのキーだけ既定に落とす */
  async get(): Promise<Settings> {
    if (this.cache) return this.cache
    const settings: Settings = { ...DEFAULT_SETTINGS }
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf-8')) as Record<string, unknown>
      if (isPersonaId(raw?.persona)) settings.persona = raw.persona
      if (isLinearWorkspace(raw?.linear_workspace)) settings.linear_workspace = raw.linear_workspace
      if (raw?.digest === true) settings.digest = true
      if (typeof raw?.next_ask === 'boolean') settings.next_ask = raw.next_ask
      if (isDigestProvider(raw?.digest_provider)) settings.digest_provider = raw.digest_provider
      if (isDigestModel(raw?.digest_model)) settings.digest_model = raw.digest_model
      if (raw?.jev === false) settings.jev = false
      if (isJevAuto(raw?.jev_auto)) settings.jev_auto = raw.jev_auto
      // Jev を切っていれば自動も切（切っている間に隠れて残った閾値で、入に戻した瞬間に自動で答えない。#499 のレビュー）
      if (!settings.jev) settings.jev_auto = 0
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

/** 次に送る文面の案を入にしているか（#560）。書いていなければ一言の入切に従う */
export function nextAskOn(s: Pick<Settings, 'digest' | 'next_ask'>): boolean {
  return s.next_ask ?? s.digest
}
