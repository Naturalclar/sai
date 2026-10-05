import { useState } from 'react'
import { formatImageBytes, thumbUrl } from '../../shared/images.ts'
import { ImageMark } from './ImageMark'
import { probeThumb } from './thumb'

/**
 * 枠に出す画像（#589）。`<img src>` は軽い版（`?thumb=1`）で、元の画像はライトボックス・ダウンロードで開いたときだけ読む。
 * 軽い版を作れない（`sips` が無いなど）ときは、画像の印・名前・大きさだけを出す（包んでいる `<a>` を押せば元を開く）。
 * 読めない（ファイルが無い・作業ディレクトリの外・画像でない）ときは `onBroken` で親に返し、親が今までどおり名前だけにする。
 * 読めたら `onSize` に絵の大きさを返す（#702。軽い版も縦横比は元と同じ）
 */
export function ThumbImage({ url, alt, onBroken, onSize }: { url: string; alt: string; onBroken?: () => void; onSize?: (width: number, height: number) => void }) {
  const [heavy, setHeavy] = useState<number | null>(null)
  // HEAD が 200 を返したら 1 回だけ読み直す（URL を変えてブラウザの失敗を引かない）
  const [retried, setRetried] = useState(false)
  const src = thumbUrl(url) + (retried ? '&retry=1' : '')
  if (heavy !== null) {
    return (
      <span className="md-image thumb-heavy" title={`${alt}\n軽い版を作れないので、押したときに元の画像を読みます`}>
        <ImageMark />
        {alt}
        {heavy > 0 ? `・${formatImageBytes(heavy)}` : ''}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onLoad={(e) => onSize?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
      onError={() => {
        void probeThumb(src).then((f) => {
          if (f.kind === 'heavy') setHeavy(f.bytes)
          else if (f.kind === 'retry' && !retried) setRetried(true)
          else onBroken?.()
        })
      }}
    />
  )
}
