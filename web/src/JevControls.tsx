import type { SettingsRequest, SettingsResponse } from './api'

interface Props {
  settings: SettingsResponse
  busy: boolean
  onChange: (patch: SettingsRequest) => void
}

/**
 * 自分のメニューの「許可を Jev で予想する」の入切（#491。既定は入）。**Jev は外部 API なので、許可の中身（コマンド・パス・理由）が外に出る**
 * ことを添える。鍵（JEV_API_KEY）はサーバの環境変数のままで、ここでは変えられない（無ければ入でも何も送らない）
 */
export function JevControls({ settings, busy, onChange }: Props) {
  const note = !settings.jev_on
    ? ''
    : settings.jev_ready
      ? '許可のコマンド・パス・理由を TypeSafe AI に送ります（ファイルの中身は送らない）'
      : 'サーバに JEV_API_KEY が無いので、送っていません'
  return (
    <div className="jev-controls">
      <button type="button" role="menuitemcheckbox" aria-checked={settings.jev_on} disabled={busy} onClick={() => onChange({ jev: !settings.jev_on })}>
        {settings.jev_on ? '✓ ' : ''}許可を Jev で予想する
      </button>
      {note && <div className="note">{note}</div>}
    </div>
  )
}
