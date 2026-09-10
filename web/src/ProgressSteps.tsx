import { useState } from 'react'
import { PROGRESS_LONG_STEP_MS, progressDuration, stepLabel, stepsSince } from '../../shared/progress.ts'
import type { SessionProgressResponse } from './api'

/**
 * 処理中のターンがいま何をしているか（#302）。「処理中 N分」の横に、いまの手順を 1 行（`Bash: pnpm test 42秒`）。
 * 押すと直近の手順が開く。since より前に始まった手順（前のターン）は出さない。手順が無ければ何も出さない。
 * now はポーリングの updatedAt（描画中に Date.now() を呼ばない。3 秒ごとに進めば十分）
 */
export function ProgressSteps({ progress, since, now }: { progress: SessionProgressResponse | null; since: string; now: number }) {
  const [open, setOpen] = useState(false)
  if (!progress) return null
  const steps = stepsSince(progress.steps, since)
  const current = steps[steps.length - 1]
  if (!current) return null
  const running = current.kind === 'tool' && !current.ended
  const long = running && now - Date.parse(current.started) > PROGRESS_LONG_STEP_MS
  // steps は末尾だけなので、それより前の手順の数を添える
  const earlier = Math.max(0, progress.total - progress.steps.length)
  return (
    <div className={`progress${long ? ' long' : ''}`}>
      <button type="button" className="current" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={`${stepLabel(current)}\n押すと直近の手順を開く`}>
        <span className="label">{stepLabel(current)}</span>
        {running && now > 0 && <span className="dur">{progressDuration(current.started, now)}</span>}
      </button>
      {open && (
        <ol className="steps">
          {earlier > 0 && <li className="more">ほか {earlier} 手順</li>}
          {steps.map((s, i) => (
            <li key={`${s.started}:${i}`} className={s.kind} title={stepLabel(s)}>
              {stepLabel(s)}
              {s.kind === 'tool' && now > 0 && <span className="dur">{s.ended ? progressDuration(s.started, Date.parse(s.ended)) : `${progressDuration(s.started, now)}〜`}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
