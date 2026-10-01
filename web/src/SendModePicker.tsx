import { SEND_MODE_LABEL, SEND_MODE_SHORT, type SendMode } from '../../shared/compact.ts'

/**
 * 送り方（#579）の選択。**閉じているときは短く出し、開いたメニューは正式な名前のまま**（#629。モデルの選択と同じ考え方）。
 *
 * 見えているのは自前のラベルで、その上に透明なネイティブの `<select>` を重ねてある（押すと OS のメニューが開き、中身は長い名前）。
 * 狭い画面・タッチ端末では短い表記（`要約` / `そのまま` / `新規`）だけを出す: 16px の select をそのまま置くと
 * 幅 390 の画面で行の半分を取り、送信ボタンが次の段に落ちていた
 */
export function SendModePicker({ value, choices, onChange }: { value: SendMode; choices: readonly SendMode[]; onChange: (mode: SendMode) => void }) {
  return (
    <span className={`send-mode${value === 'plain' ? '' : ' picked'}`} title="要約してから送ると、新しい作業の前に会話を要約して読み直す量を減らす（#579）">
      <span className="label" aria-hidden="true">
        <span className="long">{SEND_MODE_LABEL[value]}</span>
        <span className="short">{SEND_MODE_SHORT[value]}</span>
        <span className="caret">▾</span>
      </span>
      <select value={value} aria-label="送り方" onChange={(e) => onChange(e.target.value as SendMode)}>
        {choices.map((m) => (
          <option key={m} value={m}>{SEND_MODE_LABEL[m]}</option>
        ))}
      </select>
    </span>
  )
}
