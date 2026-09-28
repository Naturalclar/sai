import { useEffect, useState } from 'react'
import { api, type GalleryItem } from './api'

/**
 * そのセッションに出てきた画像（#504）。**3 秒のポーリングには載せない**（Claude の transcript を読むので）。
 * 取り直すのは「セッションを開いたとき」と「新しい発言が記録されたとき」だけで、後者は呼び出し側が `stamp` で伝える
 * （`useDiffSummary` と同じ形）。取れなければ空（一覧を出さないだけで、失敗は画面に出さない）
 */
export function useGallery(id: string | undefined, stamp: string): GalleryItem[] {
  const [loaded, setLoaded] = useState<{ key: string; items: GalleryItem[] } | null>(null)
  const key = id ? `${id} ${stamp}` : ''

  useEffect(() => {
    if (!id || !key) return
    let alive = true
    void api.gallery(id).then(
      (data) => alive && setLoaded({ key, items: data.items }),
      () => alive && setLoaded({ key, items: [] }),
    )
    return () => {
      alive = false
    }
  }, [id, key])

  // 取り直している間は前の一覧を出したままにする（同じセッションなら。空にすると新しいターンのたびに一覧がちらつく）
  if (!loaded || !id) return NONE
  return loaded.key.startsWith(`${id} `) ? loaded.items : NONE
}

const NONE: GalleryItem[] = []
