import type { MouseEvent } from 'react'
import { ARCHIVE_TITLE, RESTORE_TITLE, useArchive } from './useArchive'

/**
 * サイドバーの項目の右上に出る「アーカイブ」/「戻す」。項目のリンクとは別の要素なので、押してもページは動かない。
 * 成功すれば次のポーリングで項目ごと一覧から消える（アーカイブ済みを見ているときは「戻す」で消える）
 */
export function SessionArchiveButton({ id, archived }: { id: string; archived: boolean }) {
  const { shown, busy, error, toggle } = useArchive(id, archived)
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    void toggle()
  }
  const label = busy ? '…' : shown ? '戻す' : 'アーカイブ'
  return (
    <button type="button" className={`archive-btn${error ? ' error' : ''}`} onClick={onClick} disabled={busy} title={error || (shown ? RESTORE_TITLE : ARCHIVE_TITLE)} aria-label={shown ? 'アーカイブを解除する' : 'アーカイブする'}>
      {error ? '失敗' : label}
    </button>
  )
}
