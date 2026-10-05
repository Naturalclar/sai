import type { AnsweredApproval } from '../../shared/types.ts'
import { answeredLine } from './answeredLabels'
import { hm } from './format'

/**
 * いまのターンの間に画面から答えた許可・質問（#693）。許可のバブルは答えると消えるので、**何を答えたか**を「処理中」の上に 1 行ずつ残す
 * （Codex はフックが無く、答えたあとターンが終わるまで記録に何も増えない）。ターン完了の行が来たらサーバが載せなくなる
 */
export function AnsweredApprovals({ list }: { list: readonly AnsweredApproval[] }) {
  if (list.length === 0) return null
  return (
    <ul className="answered" aria-label="このターンで答えた許可">
      {list.map((a) => {
        const line = answeredLine(a)
        return (
          <li key={a.approval_id} className={line.tone}>
            <span className="verb"><span className="mark">{line.tone === 'deny' ? '✕' : '✓'}</span>{line.verb}</span>
            <span className="time">{hm(a.at)}</span>
            <code className="what" title={a.text}>{line.what}</code>
            {line.label && <span className="label">（{line.label}）</span>}
          </li>
        )
      })}
    </ul>
  )
}
