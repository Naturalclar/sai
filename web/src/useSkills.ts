import { useEffect, useState } from 'react'
import { api } from './api'
import type { Skill } from '../../shared/skills.ts'

/**
 * `/` の候補になるスキル。入力欄で `/` を打った時にだけ取りに行き、同じセッションでは 1 回だけ。
 * 一覧のポーリングには載せない（数が多く、3 秒ごとに流す意味が無い）。取れなければ空のまま
 */
export function useSkills(id: string | undefined, wanted: boolean): Skill[] {
  const [loaded, setLoaded] = useState<{ id: string; skills: Skill[] } | null>(null)
  useEffect(() => {
    if (!wanted || !id || loaded?.id === id) return
    let alive = true
    void api.sessionSkills(id).then(
      (res) => alive && setLoaded({ id, skills: res.skills }),
      () => alive && setLoaded({ id, skills: [] }),
    )
    return () => {
      alive = false
    }
  }, [id, wanted, loaded?.id])
  // 返信先が変わったら、前のセッションのスキルは出さない
  return loaded && loaded.id === id ? loaded.skills : []
}
