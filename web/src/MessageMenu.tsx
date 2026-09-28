import { useCallback, useEffect, useRef, useState } from 'react'
import { useDismiss } from './useDismiss'
import { MoreMark } from './MoreMark'
import { copyText } from './messageLink.ts'

/** バブルの「⋯」に渡すもの（#503）。組み立ては `Chat`（エンティティ ID を知っているのはあちら） */
export interface MessageMenuProps {
  /** この発言へのリンク（`messageLink.ts` の `messageUrl()`） */
  link: string
  /** コピーする本文（`messageCopyText()`）。空なら「本文をコピー」を出さない */
  text: string
  /** 本文が記録の時点で切れている（#358）。コピーしても続きは無いことを書き添える */
  clipped?: boolean
}

type Done = { what: 'link' | 'text'; ok: boolean } | null

/**
 * 発言ごとのメニュー（#503）。この発言へのリンクと本文をコピーする。
 * 閉じ方は見出しの「⋯」・自分のメニューと同じ `useDismiss`（外側を押す・Esc。Esc は App の「フィードへ」まで届かせない）。
 * **コピーできなかったときはリンクを選べる欄で出す**（クリップボードは安全なコンテキストでしか使えない。tailnet の素の IP の
 * `http://` など。本文は長いので欄には出さず、画面の本文を選んでもらう）
 */
export function MessageMenu({ link, text, clipped = false }: MessageMenuProps) {
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState<Done>(null)
  const ref = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  // 開いたらパネルが見えるところまで送る。チャットは自分でスクロールする箱なので、一番下の発言で開くと
  // パネルが箱の下にはみ出して見えない（狭い画面で最後の発言を開いたとき。実機の見た目で踏んだ）
  useEffect(() => {
    if (open) panel.current?.scrollIntoView({ block: 'nearest' })
  }, [open])
  // 書けたあと少し置いて閉じるタイマー。開き直した・外れたときに前のタイマーで閉じないよう、持っておいて消す
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  // useDismiss は開閉の関数を effect の依存に持つので、描画ごとに作り直さない
  const close = useCallback((next: boolean) => {
    window.clearTimeout(timer.current)
    setOpen(next)
    if (!next) setDone(null)
  }, [])
  useDismiss(ref, open, close)
  const copy = async (what: 'link' | 'text') => {
    const ok = await copyText(what === 'link' ? link : text)
    setDone({ what, ok })
    // 書けたら少しだけ「コピーしました」を見せて閉じる。書けなかったら開いたまま（代わりの手を出す）
    if (ok) timer.current = window.setTimeout(() => close(false), 900)
  }
  return (
    <div className={`msg-menu${open ? ' open' : ''}`} ref={ref}>
      <button type="button" className="iconbtn" onClick={() => close(!open)} aria-expanded={open} aria-label="この発言の操作" title="この発言の操作">
        <MoreMark />
      </button>
      {open && (
        <div className="menu" role="menu" ref={panel}>
          <button type="button" role="menuitem" onClick={() => void copy('link')}>
            {done?.what === 'link' && done.ok ? 'リンクをコピーしました' : 'この発言へのリンクをコピー'}
          </button>
          {text && (
            <button type="button" role="menuitem" onClick={() => void copy('text')}>
              {done?.what === 'text' && done.ok ? '本文をコピーしました' : '本文をコピー'}
            </button>
          )}
          {clipped && text && <div className="note">本文は記録の時点で切れています（コピーしても続きはありません）</div>}
          {done && !done.ok && (
            <div className="note">
              {done.what === 'link' ? (
                <>
                  コピーできませんでした。リンクを選んでコピーしてください
                  <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="この発言へのリンク" />
                </>
              ) : (
                'コピーできませんでした。本文を選んでコピーしてください'
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
