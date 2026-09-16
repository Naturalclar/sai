import type { TerminalDialog } from './api'

interface Props {
  dialog: TerminalDialog
}

/**
 * 端末で開いている Codex が出しているダイアログを、**読むだけ**で出す（#425）。
 * 答えるのは端末（選択の画面にキーを送ると誤って選びうる。#208。Claude の `QuestionPreview` と同じ考え方）。
 * いまカーソルが当たっている選択肢には印を付ける（そのまま Enter を押すとそれが選ばれる）
 */
export function DialogPreview({ dialog }: Props) {
  return (
    <div className="dialog-preview">
      {dialog.title && <div className="q">{dialog.title}</div>}
      {dialog.detail && <div className="desc">{dialog.detail}</div>}
      {dialog.command && <pre className="detail">{dialog.command}</pre>}
      <ol className="choices">
        {dialog.options.map((option) => (
          <li key={option.number} className={option.selected ? 'selected' : undefined}>
            <span className="num">{option.number}.</span>
            <span className="label">{option.label}</span>
            {option.selected && <span className="rec">いまここ</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}
