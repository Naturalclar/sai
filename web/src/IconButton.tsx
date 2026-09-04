import type { ReactNode, Ref } from 'react'

interface Props {
  /** 読み上げとホバーの説明。文字は出さないので必ず付ける */
  label: string
  onClick: () => void
  disabled?: boolean
  /** モーダルを閉じたあとにフォーカスを戻す先として使う */
  ref?: Ref<HTMLButtonElement>
  children: ReactNode
}

/**
 * 文字を出さない小さなボタン（鉛筆・画像・ゴミ箱など）。中身は *Mark の SVG。
 * aria-label と title に同じ文言を入れるので、見た目は絵だけでも読み上げとホバーで何のボタンか分かる
 */
export function IconButton({ label, onClick, disabled, ref, children }: Props) {
  return (
    <button ref={ref} type="button" className="iconbtn" onClick={onClick} disabled={disabled} aria-label={label} title={label}>
      {children}
    </button>
  )
}
