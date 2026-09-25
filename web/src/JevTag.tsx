import { jevLabel, jevLevel } from '../../shared/jev.ts'

/**
 * 許可のバブルに添える、許可して問題なさそうかの予想（#491。Jev が返した確率）。**表示だけ**で、押すのは今までどおり人。
 * 色分けの区切りは `shared/jev.ts` の `jevLevel()`
 */
export function JevTag({ safe }: { safe: number }) {
  return (
    <span className={`jev-tag ${jevLevel(safe)}`} title="Jev（TypeSafe AI）が、許可しても問題なさそうかを予想した確率。自動では答えません">
      Jev: {jevLabel(safe)}
    </span>
  )
}
