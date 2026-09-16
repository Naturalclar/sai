import type { TerminalDialog } from './api'

interface Props {
  dialog: TerminalDialog
}

/**
 * 端末で開いている Codex が出しているダイアログ（#425）。いまカーソルが当たっている選択肢には印を付ける
 * （端末でそのまま Enter を押すとそれが選ばれる）。
 * **下のボタンから答えられる**（#450。SAI が印をそこまで動かして Enter を送る）が、
 * 「今後も確認しない」だけはボタンにしない（効く範囲が読み切れないので端末で）
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
