import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { LightboxImage } from './lightbox'
import { LIGHTBOX_MAX_UPSCALE, stepIndex, swipeAllowed, swipeStep, TAP_MAX_PX } from './lightbox'
import { IconButton } from './IconButton'
import { CloseMark } from './CloseMark'
import { DownloadMark } from './DownloadMark'

interface Props {
  images: LightboxImage[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}

/**
 * ページの中で画像を大きく 1 枚出す（#507）。Esc・背景・✕で閉じ、同じ発言に複数あれば ← → で送る。
 * キーは capture で拾って止める（App の Esc =「フィードへ」と ← →（一覧との行き来）まで動かないように。`ProjectPicker` と同じ）。
 * 閉じたら開いたときにフォーカスがあった所へ戻す。**横にスライド（スワイプ・ドラッグ）しても送れる**（#509。Pointer Events で
 * タッチもマウスも同じ扱い。動かしている間は画像が付いてくる。画像の外を押しただけなら閉じ、スライドしただけでは閉じない）。
 * 画面より小さい画像は、画面に収まる範囲で `LIGHTBOX_MAX_UPSCALE` 倍まで拡大する（#702。読み込んで大きさが分かってから）
 */
export function ImageLightbox({ images, index, onIndex, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)
  // スライドの始まりと、いま動かしている横の量（#509）
  const start = useRef<{ x: number; y: number; id: number; backdrop: boolean } | null>(null)
  const [dragX, setDragX] = useState(0)
  // 画像の外を「押しただけ」だったか。閉じるのは pointerup ではなく click で（#510 のレビュー。pointerup で消すと、
  // タッチ端末があとから送る click が下の要素＝リンクや別のサムネイルに落ちる）。捕まえたあとの click の target は枠なので、ここで覚える
  const tapOutside = useRef(false)
  // ページをピンチで拡大している間はスライドで送らず、横の動きは横スクロールに任せる（#510 のレビュー）
  const [zoomed, setZoomed] = useState(() => !swipeAllowed(window.visualViewport?.scale))
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const onResize = () => setZoomed(!swipeAllowed(vv.scale))
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [])
  const image = images[index]
  const count = images.length
  // 読み込んだ画像の元の大きさ（#702）。どの画像のものかを一緒に持ち、送ったあと前の画像の大きさを使わない
  const [natural, setNatural] = useState<{ url: string; width: number; height: number } | null>(null)
  const size = natural && image && natural.url === image.url && natural.width > 0 && natural.height > 0 ? natural : null
  // 読めなかった画像（#702 のレビュー）。枠の画像は lazy なので、まだ読んでいない壊れた画像が並びに残ることがある
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null)

  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => back?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onIndex(stepIndex(index, count, -1))
      else if (e.key === 'ArrowRight') onIndex(stepIndex(index, count, 1))
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [index, count, onIndex, onClose])

  if (!image) return null
  return (
    <div className="modal-backdrop lightbox-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lightbox" role="dialog" aria-modal="true" aria-label={`画像: ${image.name}`}>
        <div className="lightbox-head">
          <span className="lightbox-name" title={image.name}>{image.name}</span>
          {count > 1 && <span className="lightbox-count">{index + 1} / {count}</span>}
          <a className="lightbox-dl" href={image.url} download={image.name} title="ダウンロード">
            <DownloadMark />
          </a>
          <IconButton label="閉じる" onClick={onClose} ref={closeRef}>
            <CloseMark />
          </IconButton>
        </div>
        <div
          className={`lightbox-stage${zoomed ? ' zoomed' : ''}`}
          onPointerDown={(e) => {
            // ‹ › のボタンは普通に押させる（捕まえると click がボタンに届かない）
            if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
            // 画像の外で押し始めたか（捕まえたあとの pointerup の target は常にこの枠になるので、ここで覚える）
            start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, backdrop: e.target === e.currentTarget }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            const s = start.current
            if (!s || s.id !== e.pointerId || count < 2 || zoomed) return
            setDragX(e.clientX - s.x)
          }}
          onPointerUp={(e) => {
            const s = start.current
            start.current = null
            setDragX(0)
            if (!s || s.id !== e.pointerId) return
            const dx = e.clientX - s.x
            const dy = e.clientY - s.y
            // 押しただけ: 画像の外で押し始めていたら、続く click で閉じる（画像を押しただけでは閉じない）
            if (Math.abs(dx) < TAP_MAX_PX && Math.abs(dy) < TAP_MAX_PX) {
              tapOutside.current = s.backdrop
              return
            }
            if (zoomed) return
            const step = swipeStep(dx, dy)
            if (step !== 0) onIndex(stepIndex(index, count, step))
          }}
          onClick={() => {
            if (!tapOutside.current) return
            tapOutside.current = false
            onClose()
          }}
          onPointerCancel={() => {
            start.current = null
            setDragX(0)
          }}
        >
          {count > 1 && (
            <button type="button" className="lightbox-nav prev" aria-label="前の画像" disabled={index === 0} onClick={() => onIndex(stepIndex(index, count, -1))}>‹</button>
          )}
          {brokenUrl === image.url ? (
            <span className="lightbox-broken">表示できません（ファイルが無い・作業ディレクトリの外・画像でない）</span>
          ) : (
          <img
            key={image.url}
            className={size ? 'sized' : undefined}
            src={image.url}
            alt={image.name}
            draggable={false}
            onLoad={(e) => setNatural({ url: image.url, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
            onError={() => setBrokenUrl(image.url)}
            style={{
              ...(size ? ({ '--nw': size.width, '--nh': size.height, '--up': LIGHTBOX_MAX_UPSCALE } as CSSProperties) : {}),
              ...(dragX ? { transform: `translateX(${dragX}px)`, transition: 'none' } : {}),
            }}
          />
          )}
          {count > 1 && (
            <button type="button" className="lightbox-nav next" aria-label="次の画像" disabled={index === count - 1} onClick={() => onIndex(stepIndex(index, count, 1))}>›</button>
          )}
        </div>
      </div>
    </div>
  )
}
