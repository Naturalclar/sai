import { useState } from 'react'
import type { GalleryItem } from './api'
import { sessionHash } from './hooks'
import { ImageMark } from './ImageMark'

/**
 * 一覧の 1 枚（#504）。サムネイルは押すと元の大きさで開き、下の「発言へ」でその発言に飛ぶ。
 * 配れない（`/tmp` の下・作業ディレクトリの外・消えた）ときは画像の印と名前だけ
 */
export function GalleryThumb({ id, item }: { id: string; item: GalleryItem }) {
  const [failed, setFailed] = useState(false)
  const who = item.from === 'user' ? 'あなた' : 'エージェント'
  return (
    <figure className="gallery-item">
      {failed ? (
        <span className="md-image gallery-missing" title={`${item.name}\n表示できません（ファイルが無い・作業ディレクトリの外・画像でない）`}>
          <ImageMark />
          {item.name}
        </span>
      ) : (
        <a href={item.url} target="_blank" rel="noopener noreferrer" title={`${item.name}（元の大きさで開く）`}>
          <img src={item.url} alt={item.name} loading="lazy" onError={() => setFailed(true)} />
        </a>
      )}
      <figcaption>
        {item.ts ? <a href={sessionHash(id, item.ts)} title={`この画像が出てきた${who}の発言へ`}>{who === 'あなた' ? 'あなた' : 'エージェント'} ↑</a> : <span>{who}</span>}
      </figcaption>
    </figure>
  )
}
