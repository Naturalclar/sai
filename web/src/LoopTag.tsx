import type { Loop } from './api'
import { loopLive, loopStatusLine } from '../../shared/loops.ts'

/** サイドバーの「ループ中」の印（#634）。回っている・一時停止のあいだだけ出す（終わったものは要対応で見る） */
export function LoopTag({ loop, now }: { loop: Loop; now: number }) {
  if (!loopLive(loop.status)) return null
  return (
    <span className={`tag loop${loop.status === 'paused' ? ' paused' : ''}`} title={loopStatusLine(loop, now)}>
      {loop.status === 'paused' ? 'ループ停止中' : `ループ ${loop.round}/${loop.max_rounds}`}
    </span>
  )
}
