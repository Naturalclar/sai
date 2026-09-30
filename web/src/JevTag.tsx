import { jevLabel, jevLevel, jevPercent } from '../../shared/jev.ts'

interface Props {
  /** この回の許可が問題なさそうな確率 */
  safe: number
  /** 自動の「常に許可」で書かれるルールの確率（#553。自動を入にしていて、聞き終わったときだけ） */
  rule?: { label: string; safe: number } | undefined
}

/**
 * 許可のバブルに添える、許可して問題なさそうかの予想（#491。Jev が返した確率）。押すのは人だが、自分のメニューの
 * 「自動で常に許可」（#499）を入にしていれば、**この回とルールの両方**が閾値以上の Claude の Bash の許可はサーバが答えるので
 * バブルごと消える。ルールは前方一致（`Bash(pnpm:*)` など）で広く、この回より低く出ることが多いので、ルールの確率も並べる
 * （#553。出していなかったころは「90% なのに答えない」理由が見えなかった）。色分けの区切りは `shared/jev.ts` の `jevLevel()`
 */
export function JevTag({ safe, rule }: Props) {
  const title = [
    'Jev（TypeSafe AI）が、許可しても問題なさそうかを予想した確率。',
    rule ? `「常に許可」で書かれるルール ${rule.label} は ${jevPercent(rule.safe)}%。` : '',
    '自分のメニューの「自動で常に許可」を入にすると、この回とルールの両方が閾値以上の Claude の Bash の許可は自動で答える（Bash 以外・Codex / OpenCode は答えない）',
  ].join('')
  return (
    <>
      <span className={`jev-tag ${jevLevel(safe)}`} title={title}>
        Jev: {jevLabel(safe)}
      </span>
      {rule && (
        <span className={`jev-tag ${jevLevel(rule.safe)}`} title={title}>
          ルール {jevPercent(rule.safe)}%
        </span>
      )}
    </>
  )
}
