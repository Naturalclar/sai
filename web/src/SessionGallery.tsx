import type { GalleryItem } from './api'
import { useLocalState } from './hooks'
import { GalleryThumb } from './GalleryThumb'

/**
 * セッションに出てきた画像の一覧（#504）。会話の下（処理中・許可のバブルのさらに下）に新しい順で並べる。
 * 画像が無ければ何も出さない。畳んだかは全セッション共通で localStorage の `sai.gallery` に覚える
 */
export function SessionGallery({ id, items }: { id: string; items: GalleryItem[] }) {
  const [ui, setUi] = useLocalState('sai.gallery', { open: true })
  if (items.length === 0) return null
  return (
    <section className="session-gallery" aria-label="このセッションの画像">
      <button type="button" className="gallery-head" aria-expanded={ui.open} onClick={() => setUi({ open: !ui.open })}>
        {ui.open ? '▾' : '▸'} このセッションの画像（{items.length}）
      </button>
      {ui.open && (
        <div className="gallery-grid">
          {items.map((item) => (
            <GalleryThumb key={item.url} id={id} item={item} />
          ))}
        </div>
      )}
    </section>
  )
}
