import { ARCHIVE_TITLE, RESTORE_TITLE, useArchive } from './useArchive'
import { IconButton } from './IconButton'
import { ArchiveMark } from './ArchiveMark'

/** チャット見出しの「アーカイブ」/「戻す」（箱のアイコン）。中身は useArchive */
export function ArchiveButton({ id, archived }: { id: string; archived: boolean }) {
  const { shown, busy, error, toggle } = useArchive(id, archived)
  return (
    <span className="meta archive">
      <IconButton label={shown ? RESTORE_TITLE : ARCHIVE_TITLE} onClick={() => void toggle()} disabled={busy}>
        <ArchiveMark restore={shown} />
      </IconButton>
      {error && <span className="err">{error}</span>}
    </span>
  )
}
