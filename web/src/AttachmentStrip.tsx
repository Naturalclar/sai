import { fileSizeLabel } from '../../shared/attachments.ts'
import { FileMark } from './FileMark'
import type { Attached } from './useAttachments'

interface Props {
  items: Attached[]
  onRemove: (path: string) => void
  disabled?: boolean
}

/** 入力欄の上に出る、これから送る添付。画像はサムネイル、ほかのファイル（#608）は印・名前・大きさ。✕ で外す */
export function AttachmentStrip({ items, onRemove, disabled }: Props) {
  if (items.length === 0) return null
  return (
    <div className="attachments" aria-label="添える画像・ファイル">
      {items.map((a) =>
        a.kind ? (
          <span className="thumb file" key={a.path}>
            <span className="file-chip">
              <FileMark />
              <span className="name">{a.name || (a.kind === 'pdf' ? 'PDF' : 'テキスト')}</span>
              <span className="kind">{[a.kind === 'pdf' ? 'PDF' : 'テキスト', a.size !== undefined ? fileSizeLabel(a.size) : ''].filter(Boolean).join(' · ')}</span>
            </span>
            <button type="button" onClick={() => onRemove(a.path)} disabled={disabled} aria-label="このファイルを外す" title="このファイルを外す">
              ✕
            </button>
          </span>
        ) : (
          <span className="thumb" key={a.path}>
            <img src={a.url} alt="" />
            <button type="button" onClick={() => onRemove(a.path)} disabled={disabled} aria-label="この画像を外す" title="この画像を外す">
              ✕
            </button>
          </span>
        ),
      )}
    </div>
  )
}
