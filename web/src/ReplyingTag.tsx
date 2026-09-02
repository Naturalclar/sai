import { elapsedLabel, hm } from './format'

/** 画面から送った返信をまだ処理中。since からの経過を title に。now はポーリングの updatedAt */
export function ReplyingTag({ since, now }: { since: string; now: number }) {
  const elapsed = elapsedLabel(since, now)
  return (
    <span className="tag replying" title={`${hm(since)} に送った返信を処理中${elapsed ? `（${elapsed}）` : ''}`}>
      返信中
    </span>
  )
}
