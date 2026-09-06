import type { MouseEvent } from 'react'
import type { ArchiveHandle } from './useArchive'
import { ARCHIVE_TITLE, RESTORE_TITLE } from './useArchive'
import { ArchiveMark } from './ArchiveMark'

/**
 * サイドバーの項目の右上に出る「アーカイブ」/「戻す」のアイコン。項目のリンクとは別の要素なので、押してもページは動かない。
 * 状態（useArchive）は SessionItem が持つ（スワイプのレールと同じものを使う）。
 * 成功すれば次のポーリングで項目ごと一覧から消える（アーカイブ済みを見ているときは「戻す」で消える）
 */
export function SessionArchiveButton({ archive }: { archive: ArchiveHandle }) {
  const { shown, busy, error, toggle } = archive
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    void toggle()
  }
  const label = shown ? 'アーカイブを解除する' : 'アーカイブする'
  return (
    <button
      type="button"
      className={`iconbtn archive-btn${error ? ' error' : ''}`}
      onClick={onClick}
      disabled={busy}
      title={error ? `失敗: ${error}` : shown ? RESTORE_TITLE : ARCHIVE_TITLE}
      aria-label={label}
    >
      <ArchiveMark restore={shown} />
    </button>
  )
}
