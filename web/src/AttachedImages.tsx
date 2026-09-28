import { useContext } from 'react'
import { LightboxContext, opensInPage } from './lightbox'

/** バブルに出す添付のサムネイル。押すとページの中のライトボックスで開く（#507。⌘ クリックなどは新しいタブ） */
export function AttachedImages({ urls }: { urls: string[] }) {
  const openLightbox = useContext(LightboxContext)
  if (urls.length === 0) return null
  const images = urls.map((url) => ({ url, name: '添付した画像' }))
  return (
    <div className="attached">
      {urls.map((url, i) => (
        <a
          key={url}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title="大きく開く"
          onClick={(e) => {
            if (!openLightbox || !opensInPage(e)) return
            e.preventDefault()
            openLightbox(images, i)
          }}
        >
          <img src={url} alt="添付した画像" loading="lazy" />
        </a>
      ))}
    </div>
  )
}
