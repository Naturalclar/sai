interface Props {
  /** 上に遡っている間に届いた行の数。0 なら矢印だけ */
  count: number
  onClick: () => void
}

/** チャットの右下に浮かぶ「一番下へ」。最下部が見えていないときだけ Chat が出す */
export function JumpToBottom({ count, onClick }: Props) {
  const label = count > 0 ? `一番下へ（新しい行が ${count} 件）` : '一番下へ'
  return (
    <button type="button" className="jump-bottom" onClick={onClick} aria-label={label} title={label}>
      <span aria-hidden="true">↓</span>
      {count > 0 && <span className="n">{count}</span>}
    </button>
  )
}
