import { useEffect, useState } from 'react'
import { NARROW_QUERY } from './BackLink'

/**
 * 狭い画面か（CSS の `@media (max-width: 900px)` と同じ境目）。
 * 幅で見た目が変わるものを JS 側でも切り替えるために使う（差分は広い画面ならペイン、狭ければモーダル）。
 * window を跨いだリサイズにも追従する
 */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(NARROW_QUERY).matches))
  useEffect(() => {
    const mql = window.matchMedia(NARROW_QUERY)
    const onChange = () => setNarrow(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return narrow
}
