import { splitHighlight } from '../../shared/search.ts'
import type { Hit } from '../../shared/search.ts'

/**
 * 検索の抜粋。当たったところだけ `<mark>` で囲む（#230）。
 * 割るのは `shared/search.ts` の純粋関数なので、ここは並べるだけ（HTML 文字列は作らない）
 */
export function Highlight({ text, hits }: { text: string; hits: readonly Hit[] }) {
  return (
    <>
      {splitHighlight(text, hits).map((part, i) =>
        part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
      )}
    </>
  )
}
