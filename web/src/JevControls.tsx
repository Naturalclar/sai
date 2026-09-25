import { JEV_AUTO_CHOICES, jevPercent } from '../../shared/jev.ts'
import type { SettingsRequest, SettingsResponse } from './api'

interface Props {
  settings: SettingsResponse
  busy: boolean
  onChange: (patch: SettingsRequest) => void
}

/**
 * 自分のメニューの「許可を Jev で予想する」の入切（#491。既定は入）と、「自動で常に許可」の閾値（#499。既定はしない）。
 * **Jev は外部 API なので、許可の中身（コマンド・パス・理由）が外に出る**ことを添える。鍵（JEV_API_KEY）はサーバの環境変数のままで、
 * ここでは変えられない（無ければ入でも何も送らない）。文言は下の note が正（JevTag の title は短い言い換え）
 */
export function JevControls({ settings, busy, onChange }: Props) {
  const note = !settings.jev_on
    ? ''
    : settings.jev_ready
      ? '許可のコマンド・パス・理由を TypeSafe AI に送ります（ファイルの中身は送らない）'
      : 'サーバに JEV_API_KEY が無いので、送っていません'
  // 古いサーバ（jev_auto を返さない）に当たっても壊れないように数だけ受ける。設定ファイルを手で書いて選択肢に無い値でも、その値を出す
  const auto = typeof settings.jev_auto === 'number' ? settings.jev_auto : 0
  const choices = [...new Set<number>([...JEV_AUTO_CHOICES, auto])].filter((v) => v > 0).sort((a, b) => a - b)
  return (
    <div className="jev-controls">
      <button type="button" role="menuitemcheckbox" aria-checked={settings.jev_on} disabled={busy} onClick={() => onChange({ jev: !settings.jev_on })}>
        {settings.jev_on ? '✓ ' : ''}許可を Jev で予想する
      </button>
      {note && <div className="note">{note}</div>}
      {settings.jev_on && (
        <>
          <label className="jev-auto">
            自動で常に許可:
            <select value={String(auto)} disabled={busy} aria-label="Jev の確率がこれ以上なら自動で常に許可" onChange={(e) => onChange({ jev_auto: Number(e.target.value) })}>
              <option value="0">しない</option>
              {choices.map((v) => (
                <option key={v} value={String(v)}>{jevPercent(v)}% 以上</option>
              ))}
            </select>
          </label>
          {auto > 0 && (
            <div className="note">
              Claude の返信の Bash の許可で、この回のコマンドと書かれるルール（`Bash(git status:*)` など）の両方が {jevPercent(auto)}% 以上なら、人を待たずに [常に許可] を返します。ルールは cwd の .claude/settings.local.json に書かれます（端末の「今後も許可」と同じ）。Edit / Write / MCP ツール・Codex / OpenCode は対象外で、今までどおり人が答えます
            </div>
          )}
        </>
      )}
    </div>
  )
}
