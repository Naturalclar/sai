import { resetLabel, usageLevel, windowLabel } from '../../shared/usage.ts'
import type { UsageWindow } from './api'

/** 枠 1 つぶんのゲージ（「5時間 59% · 13:30 に戻る」）。パネルの中で使う */
export function UsageBar({ window: w, now }: { window: UsageWindow; now: number }) {
  const percent = Math.round(w.used_percent)
  const reset = w.resets_at ? resetLabel(w.resets_at, now) : ''
  return (
    <div className={`usage-bar ${usageLevel(w.used_percent)}`}>
      <div className="usage-bar-top">
        <span className="usage-window">{windowLabel(w.window_minutes) || '枠'}</span>
        <b>{percent}%</b>
        {reset && <span className="usage-reset">{reset}</span>}
      </div>
      <div className="usage-track" role="img" aria-label={`${windowLabel(w.window_minutes)}の枠を ${percent}% 使用`}>
        <div className="usage-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
