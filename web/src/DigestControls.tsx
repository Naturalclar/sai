import type { PersonaId, SettingsResponse } from './api'
import { PersonaSelect } from './PersonaSelect'
import { LinearWorkspaceInput } from './LinearWorkspaceInput'

interface Props {
  settings: SettingsResponse
  busy: boolean
  error: string
  onPersona: (next: PersonaId) => void
  onLinearWorkspace: (next: string) => void
}

/**
 * 一言コメント（digest）の全体の設定（既定の性格・Linear の workspace）。一言が有効なときだけ出す。
 * 広い画面ではヘッダに並び、狭い画面では右上の自分のメニューの中に入る（#274。ヘッダの 2 行目に落ちて、
 * どの画面でも 32px を取り続けていた。どちらも一度決めたら触らない設定）
 */
export function DigestControls({ settings, busy, error, onPersona, onLinearWorkspace }: Props) {
  return (
    <div className="digest-ctl" title={error || `一言コメント: ${settings.model}（${settings.provider}）`}>
      <PersonaSelect value={settings.persona} busy={busy} onChange={onPersona} />
      <LinearWorkspaceInput value={settings.linear_workspace} busy={busy} onChange={onLinearWorkspace} />
      {error && <span className="note">{error}</span>}
    </div>
  )
}
