import { MODE_HINT, MODE_LABEL, modeEmphasis, REPLY_MODES } from '../../shared/permissions.ts'
import type { ReplyPermissionMode } from '../../shared/types.ts'
import type { SettingsRequest, SettingsResponse } from './api'

interface Props {
  settings: SettingsResponse
  busy: boolean
  onChange: (patch: SettingsRequest) => void
}

/**
 * 自分のメニューの「返信の既定の許可モード」（#582。既定は「決めない」= CLI の既定）。
 * **セッションごとに選んだ許可モード（入力欄のボタン）があればそちらが勝つ**ので、ここで変わるのは何も選んでいないセッションと、
 * これから始めるセッションだけ。並ぶのは入力欄と同じ `REPLY_MODES`、名前も同じく英語（#271）
 */
export function ReplyModeControls({ settings, busy, onChange }: Props) {
  // 古いサーバ（reply_mode を返さない）に当たっても「決めない」として出す
  const mode = settings.reply_mode ?? ''
  return (
    <div className="reply-mode-controls">
      <label className="reply-mode">
        返信の既定の許可モード
        <select value={mode} disabled={busy} aria-label="返信の既定の許可モード" onChange={(e) => onChange({ reply_mode: e.target.value as ReplyPermissionMode | '' })}>
          <option value="">{MODE_LABEL.default}</option>
          {REPLY_MODES.map((m) => (
            <option key={m} value={m}>{MODE_LABEL[m]}</option>
          ))}
        </select>
      </label>
      <div className={`note ${modeEmphasis(mode)}`.trimEnd()}>
        {mode
          ? `許可モードを選んでいない Claude のセッションと、これから始めるセッションの返信が「${MODE_LABEL[mode]}」（${MODE_HINT[mode]}）で回ります。セッションごとに選んだものがあれば、そちらが勝ちます`
          : 'セッションごとに選んだものだけが効きます（選んでいなければ CLI の既定）'}
      </div>
    </div>
  )
}
