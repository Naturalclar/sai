import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { ICON_MAX_BYTES, ICON_RADIUS_RATIO, ICON_SIZE } from '../../shared/icon.ts'
import { clampView, coverScale, cropRect, initialView, MAX_ZOOM, roundedSquarePath, zoomAt, type View } from './cropMath'

interface Props {
  file: File
  /** 「これにする」。加工後の PNG */
  onDone: (blob: Blob) => void
  onCancel: () => void
}

/** 枠の一辺。狭い画面では画面幅に合わせる */
const frameSize = () => Math.max(160, Math.min(320, Math.floor(window.innerWidth * 0.8) - 32))

/** 選んだファイルを描ける形に。createImageBitmap が無い・失敗したときは <img> で */
async function load(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      // HEIC など。下の <img> でも無理なら error
    }
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('この画像は読めません'))
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * アイコン画像の加工モーダル。正方形の枠に対して画像をドラッグで動かし、ホイールとスライダで拡大縮小して、
 * 「これにする」で ICON_SIZE px の角丸 PNG にする。計算は cropMath.ts、ここは Canvas と入力だけ
 */
export function IconCropper({ file, onDone, onCancel }: Props) {
  const [image, setImage] = useState<ImageBitmap | HTMLImageElement | null>(null)
  const [error, setError] = useState('')
  const [frame] = useState(frameSize)
  const [view, setView] = useState<View | null>(null)
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; startX: number; startY: number; view: View } | null>(null)

  const imgW = image?.width ?? 0
  const imgH = image?.height ?? 0

  useEffect(() => {
    let alive = true
    load(file)
      .then((img) => {
        if (!alive) return
        if (!img.width || !img.height) throw new Error('この画像は読めません')
        setImage(img)
        setView(initialView(img.width, img.height, frame))
      })
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [file, frame])

  // 開いたらモーダルにフォーカス（Esc を受ける）。閉じたら呼び出し側がボタンに戻す
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  // 描く: 画像 → 枠の外を暗く（角丸の穴あき）→ 枠線
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image || !view) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = frame * dpr
    canvas.height = frame * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, frame, frame)
    ctx.drawImage(image, view.x, view.y, imgW * view.scale, imgH * view.scale)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, frame, frame)
    roundedSquarePath(ctx, frame, frame * ICON_RADIUS_RATIO)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.fill('evenodd')
    ctx.restore()
    roundedSquarePath(ctx, frame, frame * ICON_RADIUS_RATIO)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }, [image, view, frame, imgW, imgH])

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!view) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, view }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    setView(clampView(imgW, imgH, frame, { ...d.view, x: d.view.x + (e.clientX - d.startX), y: d.view.y + (e.clientY - d.startY) }))
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null
  }
  const onWheel = (e: ReactWheelEvent<HTMLCanvasElement>) => {
    if (!view) return
    const rect = e.currentTarget.getBoundingClientRect()
    const factor = Math.exp(-e.deltaY * 0.002)
    setView(zoomAt(imgW, imgH, frame, view, view.scale * factor, e.clientX - rect.left, e.clientY - rect.top))
  }
  const min = image ? coverScale(imgW, imgH, frame) : 1
  const setZoom = (scale: number) => view && setView(zoomAt(imgW, imgH, frame, view, scale, frame / 2, frame / 2))

  const done = async () => {
    if (!image || !view) return
    setBusy(true)
    setError('')
    try {
      const out = document.createElement('canvas')
      out.width = ICON_SIZE
      out.height = ICON_SIZE
      const ctx = out.getContext('2d')
      if (!ctx) throw new Error('Canvas が使えません')
      roundedSquarePath(ctx, ICON_SIZE, ICON_SIZE * ICON_RADIUS_RATIO)
      ctx.clip()
      const { sx, sy, sw, sh } = cropRect(frame, view)
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, ICON_SIZE, ICON_SIZE)
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('PNG にできませんでした')
      if (blob.size > ICON_MAX_BYTES) throw new Error(`加工後の画像が大きすぎます（${Math.round(blob.size / 1024)}KB）`)
      onDone(blob)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="modal cropper"
        role="dialog"
        aria-modal="true"
        aria-label="アイコンを作る"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      >
        <div className="title">アイコンを作る</div>
        <div className="stage" style={{ width: frame, height: frame }}>
          {image && view ? (
            <canvas
              ref={canvasRef}
              style={{ width: frame, height: frame }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
              aria-label="ドラッグで動かす、ホイールで拡大縮小"
            />
          ) : (
            <div className="loading">{error || '読み込み中…'}</div>
          )}
        </div>
        <label className="zoom">
          拡大
          <input
            type="range"
            min={min}
            max={min * MAX_ZOOM}
            step={min / 100}
            value={view?.scale ?? min}
            onChange={(e) => setZoom(Number(e.target.value))}
            disabled={!view || busy}
            aria-label="拡大"
          />
        </label>
        <div className="hint">ドラッグで位置、ホイールかスライダで大きさ。{ICON_SIZE}px の角丸の PNG になります</div>
        {error && image && <div className="err">{error}</div>}
        <div className="actions">
          <button type="button" className="linkish" onClick={onCancel} disabled={busy}>
            やめる
          </button>
          <button type="button" className="primary" onClick={() => void done()} disabled={!view || busy}>
            {busy ? '作成中…' : 'これにする'}
          </button>
        </div>
      </div>
    </div>
  )
}
