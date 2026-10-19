import { useContext, useState } from 'react'
import type { GalleryItem } from './api'
import type { ImageUnavailable } from '../../shared/images.ts'
import { UnavailableImage } from './UnavailableImage'
import { LightboxContext, opensInPage } from './lightbox'
import { ThumbImage } from './ThumbImage'

/**
 * 発言のバブルの下に足す画像（#507）。バブルの中に出ていないもの（端末で貼った画像・Read で開いた画像・自分の入力に書いたパス）。
 * 押すとページの中のライトボックスで開き、同じ発言の画像は ← → で送れる。配れない（`/tmp` の下・作業ディレクトリの外・消えた）ものは名前と、分かれば理由（#820）
 */
export function MessageImages({ items }: { items: GalleryItem[] }) {
  const openLightbox = useContext(LightboxContext)
  // 読めなかった URL → 理由の区分（サーバが付けなければ null）
  const [failed, setFailed] = useState<ReadonlyMap<string, ImageUnavailable | null>>(() => new Map())
  if (items.length === 0) return null
  const shown = items.filter((i) => !failed.has(i.url))
  return (
    <div className="msg-images">
      {items.map((item) =>
        failed.has(item.url) ? (
          <UnavailableImage
            key={item.url}
            name={item.name}
            src={item.name}
            why={failed.get(item.url) ?? null}
            title={failed.get(item.url) ? item.name : `${item.name}\n表示できません（ファイルが無い・作業ディレクトリの外・画像でない）`}
          />
        ) : (
          <a
            key={item.url}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`${item.name}（大きく開く）`}
            onClick={(e) => {
              if (!openLightbox || !opensInPage(e)) return
              e.preventDefault()
              openLightbox(shown, shown.indexOf(item))
            }}
          >
            <ThumbImage url={item.url} alt={item.name} onBroken={(why) => setFailed((s) => new Map(s).set(item.url, why))} />
          </a>
        ),
      )}
    </div>
  )
}
