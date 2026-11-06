import type { SettingsRequest, SettingsResponse } from './api'

interface Props {
  settings: SettingsResponse
  busy: boolean
  onChange: (patch: SettingsRequest) => void
}

/**
 * 自分のメニューの「読むだけのコマンドを今回だけ自動で許可」の入切（#863。既定は切）。
 * 入にすると、SAI から返信した Claude の Bash のうち「常に許可」のルールを作れない形を、読むだけと分かったときだけサーバが今回だけ許可する
 * （覚えない。Jev は使わない）
 */
export function ReadOnlyOnceControls({ settings, busy, onChange }: Props) {
  // 古いサーバ（read_only_once を返さない）に当たっても切として出す
  const on = settings.read_only_once === true
  return (
    <div className="paste-controls">
      <button type="button" role="menuitemcheckbox" aria-checked={on} disabled={busy} onClick={() => onChange({ read_only_once: !on })}>
        {on ? '✓ ' : ''}読むだけのコマンドを今回だけ自動で許可
      </button>
      {on && <div className="note">SAI から返信した Claude の Bash で、「常に許可」にできない形のうち、読むだけと分かったものだけを今回だけ許可します（覚えません。ask / deny のルールに当たりうるものは人に回します）</div>}
    </div>
  )
}
