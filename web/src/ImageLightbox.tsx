import { useEffect, useRef } from 'react'
import type { LightboxImage } from './lightbox'
import { stepIndex } from './lightbox'
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
 * キーは capture で拾って止める（App の Esc =「フィードへ」と ← →（一覧との行き来）まで動かないように。`FeedProjectPicker` と同じ）。
 * 閉じたら開いたときにフォーカスがあった所へ戻す
 */
export function ImageLightbox({ images, index, onIndex, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const image = images[index]
  const count = images.length

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
        <div className="lightbox-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          {count > 1 && (
            <button type="button" className="lightbox-nav prev" aria-label="前の画像" disabled={index === 0} onClick={() => onIndex(stepIndex(index, count, -1))}>‹</button>
          )}
          <img src={image.url} alt={image.name} />
          {count > 1 && (
            <button type="button" className="lightbox-nav next" aria-label="次の画像" disabled={index === count - 1} onClick={() => onIndex(stepIndex(index, count, 1))}>›</button>
          )}
        </div>
      </div>
    </div>
  )
}
