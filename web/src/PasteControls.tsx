import { PASTE_FILE_MIN_CHARS } from '../../shared/pasteFile.ts'
import type { SettingsRequest, SettingsResponse } from './api'

interface Props {
  settings: SettingsResponse
  busy: boolean
  onChange: (patch: SettingsRequest) => void
}

/**
 * 自分のメニューの「長い貼り付けをファイルにして添える」の入切（#609。既定は切）。
 * 入にすると、入力欄に貼った文がしきい値を超えたとき、本文に入れずテキストファイルの添付にする（「本文に戻す」で戻せる）
 */
export function PasteControls({ settings, busy, onChange }: Props) {
  // 古いサーバ（paste_to_file を返さない）に当たっても切として出す
  const on = settings.paste_to_file === true
  return (
    <div className="paste-controls">
      <button type="button" role="menuitemcheckbox" aria-checked={on} disabled={busy} onClick={() => onChange({ paste_to_file: !on })}>
        {on ? '✓ ' : ''}長い貼り付けをファイルにして添える
      </button>
      {on && <div className="note">{PASTE_FILE_MIN_CHARS.toLocaleString('en-US')} 字を超える貼り付けを、本文に入れずテキストファイルにします（入力欄で「本文に戻す」を押せば戻せます）</div>}
    </div>
  )
}
