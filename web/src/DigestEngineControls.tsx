import { DIGEST_PROVIDERS } from '../../shared/digestSettings.ts'
import type { DigestProvider } from '../../shared/types.ts'
import type { SettingsRequest, SettingsResponse } from './api'
import { DigestModelInput } from './DigestModelInput'

const PROVIDER_LABEL: Record<DigestProvider, string> = {
  claude: 'claude（claude -p）',
  openai: 'OpenAI 互換（Ollama など）',
}

interface Props {
  settings: SettingsResponse
  busy: boolean
  /** PUT の失敗 */
  error: string
  onChange: (patch: SettingsRequest) => void
}

/**
 * 自分のメニューの「一言コメント」の入切・口・モデル（#288。前は環境変数で、サーバを立て直すたびに打ち直していた）。
 * どの幅でもメニューの中に出す（一度決めたら触らない設定）。**口とモデルは切のままでも選べる**（入にした瞬間に既定の claude へ本文が送られないように、先に決められる）。
 * openai 互換の送り先（SAI_DIGEST_URL）はここでは変えられない（画面から本文を外へ向けられないように）
 */
export function DigestEngineControls({ settings, busy, error, onChange }: Props) {
  const status = !settings.digest_on ? '' : settings.digest ? `${settings.model} で作成中` : settings.digest_error
  return (
    <div className="digest-engine">
      <button type="button" role="menuitemcheckbox" aria-checked={settings.digest_on} disabled={busy} onClick={() => onChange({ digest: !settings.digest_on })}>
        {settings.digest_on ? '✓ ' : ''}一言コメントを作る
      </button>
      <div className="fields">
        <select
          value={settings.provider}
          disabled={busy}
          aria-label="一言を作る口"
          title="一言を作る口。claude は claude -p（本文が Anthropic に送られる）、OpenAI 互換はサーバの SAI_DIGEST_URL（既定は手元の Ollama）"
          // 口を変えたらモデルは空（口の既定）に戻す。claude に qwen3:8b のようなローカルのモデル名を渡すと一言が 1 つも付かない
          onChange={(e) => onChange({ digest_provider: e.target.value as DigestProvider, digest_model: '' })}
        >
          {DIGEST_PROVIDERS.map((p) => (
            <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>
          ))}
        </select>
        <DigestModelInput
          value={settings.digest_model}
          placeholder={settings.provider === 'claude' ? 'haiku（既定）' : 'モデル名（例 qwen3:8b）'}
          busy={busy}
          onChange={(digest_model) => onChange({ digest_model })}
        />
        {(error || status) && <div className={`note${error || !settings.digest ? ' error' : ''}`}>{error || status}</div>}
      </div>
    </div>
  )
}
