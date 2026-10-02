import type { AttachedFile } from '../../shared/attachments.ts'
import { FileMark } from './FileMark'

/**
 * バブルに出す、画像以外の添付（#608。文字のファイルと PDF）。印と元の名前だけで、**開くリンクにはしない**
 * （配る口は画像だけ。HTML / SVG を同じオリジンで描かせない。画面で読むのは #603 の作りに乗せる）
 */
export function AttachedFiles({ files }: { files: readonly AttachedFile[] }) {
  if (files.length === 0) return null
  return (
    <div className="attached-files">
      {files.map((f) => (
        <span className="file-chip" key={f.key} title="エージェントには置き場のパスで渡しています">
          <FileMark />
          <span className="name">{f.name || (f.kind === 'pdf' ? 'PDF' : 'テキスト')}</span>
          <span className="kind">{f.kind === 'pdf' ? 'PDF' : 'テキスト'}</span>
        </span>
      ))}
    </div>
  )
}
