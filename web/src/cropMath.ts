// アイコン加工（IconCropper）の計算だけ。Canvas に触らないので node:test で回す（cropMath.test.ts）。
// 座標は「枠（正方形、左上が原点、一辺 frame）」の中に画像を (x, y) から scale 倍で置いたもの。
// 画像は常に枠を覆う（枠の外に余白を作らない）ように clamp する

export interface View {
  scale: number
  x: number
  y: number
}

/** 枠を覆う最小の倍率 */
export function coverScale(imgW: number, imgH: number, frame: number): number {
  return Math.max(frame / imgW, frame / imgH)
}

/** 最大の倍率。最小の 4 倍まで（それ以上は荒れるだけ） */
export const MAX_ZOOM = 4

/** 画像が枠を覆ったまま、はみ出しの範囲に x, y を収める */
export function clampView(imgW: number, imgH: number, frame: number, view: View): View {
  const min = coverScale(imgW, imgH, frame)
  const scale = Math.min(Math.max(view.scale, min), min * MAX_ZOOM)
  const w = imgW * scale
  const h = imgH * scale
  return {
    scale,
    x: Math.min(0, Math.max(frame - w, view.x)),
    y: Math.min(0, Math.max(frame - h, view.y)),
  }
}

/** 枠の中央に置いた初期状態 */
export function initialView(imgW: number, imgH: number, frame: number): View {
  const scale = coverScale(imgW, imgH, frame)
  return clampView(imgW, imgH, frame, { scale, x: (frame - imgW * scale) / 2, y: (frame - imgH * scale) / 2 })
}

/** 点 (px, py)（枠の座標）の下にある画像の点を動かさずに倍率を変える */
export function zoomAt(imgW: number, imgH: number, frame: number, view: View, nextScale: number, px: number, py: number): View {
  const min = coverScale(imgW, imgH, frame)
  const scale = Math.min(Math.max(nextScale, min), min * MAX_ZOOM)
  const k = scale / view.scale
  return clampView(imgW, imgH, frame, { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k })
}

/** 枠に入っている部分の、元画像での矩形（drawImage の source 引数） */
export function cropRect(frame: number, view: View): { sx: number; sy: number; sw: number; sh: number } {
  // `-0 / scale` は -0 になる。値としては同じだが、テストの deepEqual で区別されるので 0 に揃える
  return { sx: (0 - view.x) / view.scale || 0, sy: (0 - view.y) / view.scale || 0, sw: frame / view.scale, sh: frame / view.scale }
}

/** 角丸の正方形のパス。roundRect() が無いブラウザでも動くように自前で引く */
export function roundedSquarePath(ctx: CanvasRenderingContext2D, size: number, radius: number): void {
  const r = Math.min(radius, size / 2)
  ctx.beginPath()
  ctx.moveTo(r, 0)
  ctx.lineTo(size - r, 0)
  ctx.arcTo(size, 0, size, r, r)
  ctx.lineTo(size, size - r)
  ctx.arcTo(size, size, size - r, size, r)
  ctx.lineTo(r, size)
  ctx.arcTo(0, size, 0, size - r, r)
  ctx.lineTo(0, r)
  ctx.arcTo(0, 0, r, 0, r)
  ctx.closePath()
}
