import type { Profile } from './api'
import { PendingBubble } from './PendingBubble'
import { ProgressSteps } from './ProgressSteps'
import { useProgress } from './useProgress'

/**
 * フィードの処理中の仮バブル。そのセッションがいま何をしているか（#302）を取って添える。
 * 取るのはバブルが出ている間だけ（フィードは複数のセッションが同時に処理中になるので、バブルごとに持つ）
 */
export function FeedPendingBubble({ id, text, since, now, repo, quiet, profile }: { id: string; text: string; since: string; now: number; repo?: string; quiet?: boolean; profile?: Profile }) {
  const progress = useProgress(id, true)
  return (
    <PendingBubble text={text} since={since} now={now} repo={repo} quiet={quiet} profile={profile}>
      <ProgressSteps progress={progress} since={since} now={now} />
    </PendingBubble>
  )
}
