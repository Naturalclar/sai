import { jevLabel, jevLevel } from '../../shared/jev.ts'

/**
 * 許可のバブルに添える、許可して問題なさそうかの予想（#491。Jev が返した確率）。押すのは人だが、自分のメニューの
 * 「自動で常に許可」（#499）を入にしていれば、閾値以上の Claude の許可はサーバが答えるのでバブルごと消える。
 * 色分けの区切りは `shared/jev.ts` の `jevLevel()`
 */
export function JevTag({ safe }: { safe: number }) {
  return (
    <span className={`jev-tag ${jevLevel(safe)}`} title="Jev（TypeSafe AI）が、許可しても問題なさそうかを予想した確率。自分のメニューの「自動で常に許可」を入にすると、閾値以上の Claude の許可は自動で答える">
      Jev: {jevLabel(safe)}
    </span>
  )
}
