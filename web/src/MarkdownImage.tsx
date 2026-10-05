import { useContext, useState, type CSSProperties } from 'react'
import { imageName } from '../../shared/markdown.ts'
import { ImageSourceContext } from './imageContext'
import { ImageMark } from './ImageMark'
import { DownloadMark } from './DownloadMark'
import { LightboxContext, opensInPage } from './lightbox'
import { ThumbImage } from './ThumbImage'
import { BodyImagesContext, bodyImages, lightboxFrom } from './bodyImages'
import { bandLayout, type BandLayout } from './imageShape'

/**
 * 本文の中の手元の画像（#321）。サーバが配れば（`GET /api/sessions/<id>/images/<key>`）サムネイル（押すとページの中のライトボックスで開く。#507）と
 * ダウンロードのボタン、配る口が無い・読めなかった（ファイルが無い、作業ディレクトリの外、画像でない）ときは画像の印と名前だけ。
 * 横に細長い画像（帯）は幅の上限を外し、押せる場所は絵の大きさに頼らない（#702。`bandLayout()` と `.md-img` の CSS）。
 * ライトボックスには同じ発言の本文の画像を並びごと渡す（← → で送れる）
 */
export function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const urlOf = useContext(ImageSourceContext)
  const openLightbox = useContext(LightboxContext)
  const body = useContext(BodyImagesContext)
  const [failed, setFailed] = useState(false)
  const [band, setBand] = useState<BandLayout | null>(null)
  const name = alt || imageName(src)
  const url = urlOf?.(src)
  if (!url || failed) {
    return (
      <span className="md-image" title={failed ? `${src}\n表示できません（ファイルが無い・作業ディレクトリの外・画像でない）` : src}>
        <ImageMark />
        {name}
      </span>
    )
  }
  return (
    <span className={`md-img${band ? ' band' : ''}`} style={band ? ({ '--cap': `${band.cap}px`, '--floor': `${band.floor}px` } as CSSProperties) : undefined}>
      {/* 押したらページの中のライトボックスで開く（#507）。⌘ クリックなどはブラウザの既定のまま */}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="大きく開く"
        onClick={(e) => {
          if (!openLightbox || !opensInPage(e)) return
          e.preventDefault()
          const shown = lightboxFrom(body && urlOf ? bodyImages(body.text, urlOf, body.broken) : [], { url, name })
          openLightbox(shown.images, shown.index)
        }}
      >
        <ThumbImage
          url={url}
          alt={name}
          onSize={(w, h) => setBand(bandLayout(w, h))}
          onBroken={() => {
            setFailed(true)
            body?.markBroken(url)
          }}
        />
      </a>
      <a className="md-img-dl" href={`${url}?download=1`} download={imageName(src)} title={`${src} をダウンロード`}>
        <DownloadMark />
        {name}
      </a>
    </span>
  )
}
