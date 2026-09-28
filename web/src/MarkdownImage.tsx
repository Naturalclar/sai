import { useContext, useState } from 'react'
import { imageName } from '../../shared/markdown.ts'
import { ImageSourceContext } from './imageContext'
import { ImageMark } from './ImageMark'
import { DownloadMark } from './DownloadMark'
import { LightboxContext, opensInPage } from './lightbox'

/**
 * 本文の中の手元の画像（#321）。サーバが配れば（`GET /api/sessions/<id>/images/<key>`）サムネイル（押すとページの中のライトボックスで開く。#507）と
 * ダウンロードのボタン、配る口が無い・読めなかった（ファイルが無い、作業ディレクトリの外、画像でない）ときは画像の印と名前だけ
 */
export function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const urlOf = useContext(ImageSourceContext)
  const openLightbox = useContext(LightboxContext)
  const [failed, setFailed] = useState(false)
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
    <span className="md-img">
      {/* 押したらページの中のライトボックスで開く（#507）。⌘ クリックなどはブラウザの既定のまま */}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="大きく開く"
        onClick={(e) => {
          if (!openLightbox || !opensInPage(e)) return
          e.preventDefault()
          openLightbox([{ url, name }], 0)
        }}
      >
        <img src={url} alt={name} loading="lazy" onError={() => setFailed(true)} />
      </a>
      <a className="md-img-dl" href={`${url}?download=1`} download={imageName(src)} title={`${src} をダウンロード`}>
        <DownloadMark />
        {name}
      </a>
    </span>
  )
}
