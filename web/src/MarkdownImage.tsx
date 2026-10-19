import { useContext, useState, type CSSProperties } from 'react'
import { imageName } from '../../shared/markdown.ts'
import type { ImageUnavailable } from '../../shared/images.ts'
import { ImageNoSourceContext, ImageSourceContext } from './imageContext'
import { UnavailableImage } from './UnavailableImage'
import { DownloadMark } from './DownloadMark'
import { LightboxContext, opensInPage } from './lightbox'
import { ThumbImage } from './ThumbImage'
import { BodyImagesContext, bodyImages, lightboxFrom } from './bodyImages'
import { bandLayout, type BandLayout } from './imageShape'

/**
 * 本文の中の手元の画像（#321）。サーバが配れば（`GET /api/sessions/<id>/images/<key>`）サムネイル（押すとページの中のライトボックスで開く。#507）と
 * ダウンロードのボタン、配る口が無い・読めなかった（ファイルが無い、作業ディレクトリの外、画像でない）ときは画像の印と名前と、分かれば理由（#820）。
 * 横に細長い画像（帯）は幅の上限を外し、押せる場所は絵の大きさに頼らない（#702。`bandLayout()` と `.md-img` の CSS）。
 * ライトボックスには同じ発言の本文の画像を並びごと渡す（← → で送れる）
 */
export function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const urlOf = useContext(ImageSourceContext)
  const openLightbox = useContext(LightboxContext)
  const body = useContext(BodyImagesContext)
  const noSource = useContext(ImageNoSourceContext)
  // 読めなかったら理由の区分（サーバが付けなければ null）。undefined はまだ読めている
  const [failed, setFailed] = useState<ImageUnavailable | null | undefined>(undefined)
  const [band, setBand] = useState<BandLayout | null>(null)
  const name = alt || imageName(src)
  const url = urlOf?.(src)
  if (!url) return <UnavailableImage name={name} src={src} why={noSource} title={src} />
  if (failed !== undefined) {
    return <UnavailableImage name={name} src={src} why={failed} title={failed ? src : `${src}\n表示できません（ファイルが無い・作業ディレクトリの外・画像でない）`} />
  }
  // 読めなかったら名前（と理由）だけにし、同じ発言のライトボックスの並びからも外す
  const broken = (why: ImageUnavailable | null) => {
    setFailed(why)
    body?.markBroken(url)
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
        <ThumbImage url={url} alt={name} onSize={(w, h) => setBand(bandLayout(w, h))} onBroken={broken} />
      </a>
      <a className="md-img-dl" href={`${url}?download=1`} download={imageName(src)} title={`${src} をダウンロード`}>
        <DownloadMark />
        {name}
      </a>
    </span>
  )
}
