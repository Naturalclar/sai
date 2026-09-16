// 返信で選べるモデルを本体に聞く（#394）。`useSkills` と同じ形で、**メニューを開いたときだけ**取りに行き、
// 同じセッションでは 1 回だけ。一覧のポーリングには載せない（開かない人は叩かない）。取れなければ空のまま
import { useEffect, useState } from 'react'
import { api } from './api'

export function useModels(id: string | undefined, wanted: boolean): string[] {
  const [loaded, setLoaded] = useState<{ id: string; models: string[] } | null>(null)
  useEffect(() => {
    if (!wanted || !id || loaded?.id === id) return
    let alive = true
    void api.sessionModels(id).then(
      (res) => alive && setLoaded({ id, models: res.models }),
      () => alive && setLoaded({ id, models: [] }),
    )
    return () => {
      alive = false
    }
  }, [id, wanted, loaded?.id])
  // 返信先が変わったら、前のセッションの候補は出さない
  return loaded && loaded.id === id ? loaded.models : []
}
