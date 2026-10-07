import { resetLabel, usageLevel, windowExpired, windowLabel } from '../../shared/usage.ts'
import type { UsageWindow } from './api'
import { USAGE_WAITING_NOTE } from './usageChips'

/**
 * 枠 1 つぶんのゲージ（「5時間 59% · 13:30 に戻る」）。パネルの中で使う。
 * 復帰時刻を過ぎた枠は割合もゲージも出さず「更新待ち」にする（#726。前の枠の割合をいまの値として出さない）
 */
export function UsageBar({ window: w, now }: { window: UsageWindow; now: number }) {
  const percent = Math.round(w.used_percent)
  const reset = w.resets_at ? resetLabel(w.resets_at, now) : ''
  if (windowExpired(w, now)) {
    return (
      <div className="usage-bar missing">
        <div className="usage-bar-top">
          <span className="usage-window">{windowLabel(w.window_minutes) || '枠'}</span>
          <b>更新待ち</b>
        </div>
        <div className="usage-bar-note">
          {reset}・{USAGE_WAITING_NOTE}
        </div>
      </div>
    )
  }
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
