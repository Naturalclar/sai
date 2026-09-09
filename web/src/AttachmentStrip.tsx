import type { Attached } from './useAttachments'

interface Props {
  items: Attached[]
  onRemove: (path: string) => void
  disabled?: boolean
}

/** 入力欄の上に出る、これから送る画像のサムネイル。✕ で外す */
export function AttachmentStrip({ items, onRemove, disabled }: Props) {
  if (items.length === 0) return null
  return (
    <div className="attachments" aria-label="添える画像">
      {items.map((a) => (
        <span className="thumb" key={a.path}>
          <img src={a.url} alt="" />
          <button type="button" onClick={() => onRemove(a.path)} disabled={disabled} aria-label="この画像を外す" title="この画像を外す">
            ✕
          </button>
        </span>
      ))}
    </div>
  )
}
