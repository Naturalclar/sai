import { JEV_AUTO_CHOICES } from '../../shared/jev.ts'
import type { SettingsRequest, SettingsResponse } from './api'

interface Props {
  settings: SettingsResponse
  busy: boolean
  onChange: (patch: SettingsRequest) => void
}

/**
 * 自分のメニューの「許可を Jev で予想する」の入切（#491。既定は入）。**Jev は外部 API なので、許可の中身（コマンド・パス・理由）が外に出る**
 * ことを添える。鍵（JEV_API_KEY）はサーバの環境変数のままで、ここでは変えられない（無ければ入でも何も送らない）。
 * **自動で常に許可**（#499）: 確率が閾値以上なら人を待たずに [常に許可] と同じ答えを返す。既定は「しない」。
 * Claude の返信の許可だけ（Codex / OpenCode には「常に許可」が無い）で、ルールが cwd の .claude/settings.local.json に書かれる
 */
export function JevControls({ settings, busy, onChange }: Props) {
  const note = !settings.jev_on
    ? ''
    : settings.jev_ready
      ? '許可のコマンド・パス・理由を TypeSafe AI に送ります（ファイルの中身は送らない）'
      : 'サーバに JEV_API_KEY が無いので、送っていません'
  // 設定ファイルを手で書いて選択肢に無い値になっていても、その値を出す（黙って別の値に見せない）
  const choices: number[] = JEV_AUTO_CHOICES.includes(settings.jev_auto as (typeof JEV_AUTO_CHOICES)[number]) || settings.jev_auto === 0 ? [...JEV_AUTO_CHOICES] : [...JEV_AUTO_CHOICES, settings.jev_auto].sort()
  return (
    <div className="jev-controls">
      <button type="button" role="menuitemcheckbox" aria-checked={settings.jev_on} disabled={busy} onClick={() => onChange({ jev: !settings.jev_on })}>
        {settings.jev_on ? '✓ ' : ''}許可を Jev で予想する
      </button>
      {note && <div className="note">{note}</div>}
      {settings.jev_on && (
        <label className="jev-auto">
          自動で常に許可:
          <select value={String(settings.jev_auto)} disabled={busy || !settings.jev_ready} aria-label="Jev の確率がこれ以上なら自動で常に許可" onChange={(e) => onChange({ jev_auto: Number(e.target.value) })}>
            <option value="0">しない</option>
            {choices.map((v) => (
              <option key={v} value={String(v)}>{Math.round(v * 100)}% 以上</option>
            ))}
          </select>
        </label>
      )}
      {settings.jev_on && settings.jev_auto > 0 && (
        <div className="note">Claude の返信の許可で、問題なさそうな確率が {Math.round(settings.jev_auto * 100)}% 以上なら人を待たずに [常に許可] を返します。ルールは cwd の .claude/settings.local.json に書かれます（端末の「今後も許可」と同じ。Codex / OpenCode は対象外）</div>
      )}
    </div>
  )
}
