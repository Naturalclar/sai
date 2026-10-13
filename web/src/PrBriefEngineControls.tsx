import { DIGEST_PROVIDERS } from '../../shared/digestSettings.ts'
import type { DigestProvider } from '../../shared/types.ts'
import type { SettingsRequest, SettingsResponse } from './api'
import { DigestModelInput } from './DigestModelInput'

const PROVIDER_LABEL: Record<DigestProvider, string> = {
  claude: 'claude（claude -p）',
  openai: 'OpenAI 互換（Ollama など）',
}

/**
 * 自分のメニューの「PR の要約を作る口」（#790）。**既定は「一言と同じ口」**。別の口を選ぶと、一言の入切・口はそのままで、
 * PR の要約だけその口で作る（手元のモデルで一言を作りながら、要約だけ `claude -p` に回す、など）。
 * openai 互換の送り先（SAI_DIGEST_URL）は一言と同じで、ここでは変えられない
 */
export function PrBriefEngineControls({ settings, busy, onChange }: { settings: SettingsResponse; busy: boolean; onChange: (patch: SettingsRequest) => void }) {
  const provider = settings.pr_summary_provider
  return (
    <div className="digest-engine pr-brief-engine">
      <div className="label">PR の要約を作る口</div>
      <div className="fields">
        <select
          value={provider}
          disabled={busy}
          aria-label="PR の要約を作る口"
          title="PR の要約を作る口。押したときだけ、その PR の本文・差分・コメントがこの口に渡る。claude は claude -p（Anthropic に送られる）、OpenAI 互換はサーバの SAI_DIGEST_URL（既定は手元の Ollama）"
          // 口を変えたらモデルは空（口の既定）に戻す（一言の口と同じ理由）
          onChange={(e) => onChange({ pr_summary_provider: e.target.value as DigestProvider | '', pr_summary_model: '' })}
        >
          <option value="">一言と同じ口</option>
          {DIGEST_PROVIDERS.map((p) => (
            <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>
          ))}
        </select>
        {provider !== '' && (
          <DigestModelInput
            value={settings.pr_summary_model}
            placeholder={provider === 'claude' ? 'haiku（既定）' : 'モデル名（例 qwen3:8b）'}
            busy={busy}
            label="PR の要約を作るモデル"
            onChange={(pr_summary_model) => onChange({ pr_summary_model })}
          />
        )}
        {provider === 'openai' && !settings.pr_summary_model && <div className="note error">openai の口にはモデル名が要ります</div>}
      </div>
    </div>
  )
}
