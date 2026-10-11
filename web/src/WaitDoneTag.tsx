import type { Wait } from './api'
import { waitDoneText } from '../../shared/waits.ts'

/**
 * サイドバーの「待ちが終わっている」の印（#732）。終わったが自動では起こさない待ち（`waitNeedsHuman()`）があるあいだだけ出す。
 * 起こす・片付けるのは要対応の行か、そのセッションの帯
 */
export function WaitDoneTag({ wait }: { wait: Wait }) {
  return (
    <span className="tag wait-done" title={`${waitDoneText(wait)}。自動では起こしません（要対応か、このセッションの帯から「いま起こす」か「片付ける」を押します）`}>
      CI 終了・未起こし
    </span>
  )
}
