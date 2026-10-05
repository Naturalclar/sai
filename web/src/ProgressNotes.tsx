import { notesSince } from '../../shared/progress.ts'
import type { SessionProgressResponse } from './api'
import { ProgressNoteItem } from './ProgressNoteItem'
import { noteKeys, shownNotes } from './noteClamp.ts'

/**
 * 処理中のターンの途中でエージェントが書いた文（#680。Codex の commentary・Claude のツールの合間の文）。
 * 仮バブルのすぐ下に、エージェントの側の薄い文として出す。行（JSONL）には無いので、ターンが終わって仮バブルが消えると一緒に消える
 * （あとからは「手順」を開くと読める）。since より前の文（前のターン）は出さない。max は出す数（フィードは最新の 1 つ）
 */
export function ProgressNotes({ progress, since, max }: { progress: SessionProgressResponse | null; since: string; max?: number }) {
  const notes = notesSince(progress?.notes ?? [], since)
  const { shown, earlier } = shownNotes(notes, progress?.notes_total ?? notes.length, progress?.notes?.length ?? 0, max)
  if (shown.length === 0) return null
  const keys = noteKeys(shown)
  return (
    <ol className="progress-notes" aria-label="処理中のターンの途中の文">
      {earlier > 0 && <li className="more">ほか {earlier} 件（終わったあと「手順」で読めます）</li>}
      {shown.map((n, i) => (
        <ProgressNoteItem key={keys[i]} note={n} />
      ))}
    </ol>
  )
}
