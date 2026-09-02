import type { MouseEvent } from 'react'

/** 狭い画面の境目。styles.css の @media (max-width: 900px) と同じ値 */
export const NARROW_QUERY = '(max-width: 900px)'

/**
 * チャット側の「← 一覧」。出るのは2つの場面で、押したときの意味が違う:
 * - 狭い画面（一覧かチャットのどちらかだけ）: `#/` へ移って一覧を出す
 * - 広い画面でサイドバーを閉じているとき: ページは変えず、サイドバーを開くだけ
 * どちらで出ているかは CSS が決めるので、ここでは押された瞬間の幅で判断する
 */
export function BackLink({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (window.matchMedia(NARROW_QUERY).matches) return
    e.preventDefault()
    onOpenSidebar()
  }
  return (
    <a className="back" href="#/" onClick={onClick}>← 一覧</a>
  )
}
