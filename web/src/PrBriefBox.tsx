import { useState } from 'react'
import { briefState, prCommentCount } from '../../shared/prBrief.ts'
import { api, type PrBrief, type PrDetailResponse } from './api'
import { agoLabel } from './prLabels'
import { briefButtonLabel, newerBrief } from './prBriefLabels'

/**
 * PR の要約（#790）。見出しの下・本文の上の畳める欄。**押したときだけ作る**（開いただけでは作らない）。
 *
 * - ボタンの近くに、材料（本文・差分・コメント）をどこへ送るかを書く（`summary_via`。一言と同じ口）。口が無ければボタンは出さず、
 *   覚えた要約も無ければ欄ごと出さない
 * - 要約は**文字として描く**（Markdown にしない。他人が書いた文から作ったものなので、リンクや画像にしない）
 * - 作ったあとに push があれば「古い要約」、コメントが増えていればその数を添える
 */
export function PrBriefBox({ repo, number, data, now }: { repo: string; number: number; data: PrDetailResponse; now: number }) {
  const [made, setMade] = useState<PrBrief | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const brief = newerBrief(made, data.summary ?? null)
  const via = data.summary_via ?? ''
  if (!brief && !via) return null
  const state = brief ? briefState(brief, data.pr.head_sha, prCommentCount(data)) : null
  const label = briefButtonLabel(brief !== null, state)
  const make = () => {
    setBusy(true)
    setError('')
    api.makePrBrief(repo, number).then(
      (r) => {
        setMade(r.summary)
        setBusy(false)
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      },
    )
  }
  return (
    <details className="pr-brief" open>
      <summary>要約</summary>
      {brief && <div className="text">{brief.text}</div>}
      {state?.stale && <div className="warn">古い要約です（作ったあとに push がありました）</div>}
      {state && state.added > 0 && <div className="warn">作ったあとにコメントが {state.added} 件増えています</div>}
      {brief?.notes.map((n) => (
        <div className="trimmed" key={`note:${n}`}>{n}</div>
      ))}
      {brief && (
        <div className="made">
          {agoLabel(brief.at, now)}に作成{brief.via ? `（${brief.via}）` : ''}。GitHub には載せていません
        </div>
      )}
      {error && <div className="warn">{error}</div>}
      {via && label && (
        <div className="foot">
          <button type="button" disabled={busy} onClick={make}>
            {busy ? '作っています…' : label}
          </button>
          <span className="via">
            押すと、この PR の本文・差分・コメントを <code>{via}</code> に送ります
          </span>
        </div>
      )}
    </details>
  )
}
