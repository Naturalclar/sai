import { useEffect, useMemo, useRef, useState } from 'react'
import { imagesByBubble } from '../../shared/gallery.ts'
import { api, type GalleryItem } from './api'

type BubbleImages = ReadonlyMap<string, GalleryItem[]>

const NONE: ReadonlyMap<string, BubbleImages> = new Map()

/**
 * フィードのバブルの下に出す画像（#657）。`useGallery` の複数セッション版で、返すのは
 * セッションのエンティティ ID → （`bubbleKey(ts, 側)` → 画像）。**鍵をセッションで分ける**ので、別のセッションの同じ秒の発言とぶつからない。
 *
 * 取りに行くのは `stamps`（`feedGallery.ts` の `galleryStamps()`）に載っているものだけで、**取り直すのはそのセッションの目印が
 * 変わったときだけ**。3 秒のポーリングには載せない（Claude の transcript / Codex の rollout を読むので）。
 * **1 つずつ順に取る**（開いた直後にセッションの数だけ同時に投げると、ポーリングの往復を待たせる）。
 * 取り直している間は前の画像を出したまま。取れなければ載せないだけで、同じ目印では取り直さない
 */
export function useGalleries(stamps: ReadonlyMap<string, string>): ReadonlyMap<string, BubbleImages> {
  const [loaded, setLoaded] = useState(NONE)
  // 投げた (id → 目印)。フィードの行が増えるたびに effect が走るが、目印が同じなら投げ直さない
  const asked = useRef(new Map<string, string>())
  // 前の取得が終わってから次を投げるための列
  const chain = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    for (const [id, stamp] of stamps) {
      if (asked.current.get(id) === stamp) continue
      asked.current.set(id, stamp)
      chain.current = chain.current.then(() =>
        api.gallery(id).then(
          (data) => setLoaded((prev) => new Map(prev).set(id, imagesByBubble(data.items))),
          // 読めない。画像を出さないだけ（失敗は画面に出さない）
          () => {},
        ),
      )
    }
  }, [stamps])

  // 窓やリポジトリの切り替えで行から消えたセッション・上限から外れたセッションの分は出さない
  return useMemo(() => {
    const out = new Map<string, BubbleImages>()
    for (const id of stamps.keys()) {
      const images = loaded.get(id)
      if (images && images.size > 0) out.set(id, images)
    }
    return out
  }, [loaded, stamps])
}
