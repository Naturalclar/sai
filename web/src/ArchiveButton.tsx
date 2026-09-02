import { ARCHIVE_TITLE, RESTORE_TITLE, useArchive } from './useArchive'

/** チャット見出しの「アーカイブ」/「戻す」。中身は useArchive */
export function ArchiveButton({ id, archived }: { id: string; archived: boolean }) {
  const { shown, busy, error, toggle } = useArchive(id, archived)
  return (
    <span className="meta archive">
      <button type="button" className="linkish" onClick={() => void toggle()} disabled={busy} title={shown ? RESTORE_TITLE : ARCHIVE_TITLE}>
        {busy ? '…' : shown ? '戻す' : 'アーカイブ'}
      </button>
      {error && <span className="err">{error}</span>}
    </span>
  )
}
