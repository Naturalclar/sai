import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useDismiss } from './useDismiss'
import { MoreMark } from './MoreMark'

/**
 * 狭い画面のチャット見出しの「⋯」（#274）。押すと、見出しの直下に詳しい情報と操作のパネルを重ねる。
 * 開閉はここだけが持つ。中身（children）は 3 秒のポーリングで描き直されるが、この部品は呼び出し側の key（セッション ID）が
 * 変わらない限り作り直されないので、更新のたびに閉じたりはしない。
 * **パネルは `.chat-head` の中に置く**（タッチ端末の 16px / 36px の指定が `.chat-head` に閉じている。外に出すと
 * iOS で名前の入力欄や性格の select を押したときに画面が拡大する。#122 / #127）。
 * 中で開くモーダル（アイコンの加工・許可の一覧）はポータルを使わないので DOM ではパネルの中にあり、押しても閉じない
 */
export function SessionHeadMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, setOpen)
  const label = open ? '詳細と操作を閉じる' : '詳細と操作'
  return (
    <div className="head-more" ref={ref}>
      <button type="button" className="iconbtn" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={label} title={label}>
        <MoreMark />
      </button>
      {open && (
        <div className="head-panel" role="group" aria-label="セッションの詳細と操作">
          {children}
        </div>
      )}
    </div>
  )
}
