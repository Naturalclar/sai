import type { TurnUsage } from '../../shared/turnUsage.ts'
import { usageLabel, usageLoud, usageTitle } from './usageLabel.ts'

/**
 * そのターンが使ったトークン（#411）。SAI が起こした Claude のターンにだけ付く（端末で打ったターンには付かない）。
 * 内訳と費用は title の中（`usageLabel.ts`）
 */
export function TurnUsageTag({ usage }: { usage: TurnUsage }) {
  return (
    <span className={`tag usage${usageLoud(usage) ? ' loud' : ''}`} title={usageTitle(usage)}>
      {usageLabel(usage)}
    </span>
  )
}
