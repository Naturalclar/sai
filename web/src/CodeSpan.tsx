import { useContext } from 'react'
import { fileRefOf } from '../../shared/files.ts'
import { FileOpenContext, FileSessionContext } from './fileContext'

/**
 * 行の中の `` `コード` ``。**中身がまるごとファイルのパスの形**（`server/app.ts`・`docs/screen.md:12`）で、開ける先のセッションがあれば、
 * 押すと SAI の中でそのファイルを読める（#603）。読めるかは押したときにサーバが決める（無い・作業ディレクトリの外・文字でない、は理由を出す）。
 * それ以外は今までどおりただのコード
 */
export function CodeSpan({ text }: { text: string }) {
  const id = useContext(FileSessionContext)
  const open = useContext(FileOpenContext)
  const ref = id && open ? fileRefOf(text) : null
  if (!id || !open || !ref) return <code>{text}</code>
  return (
    <button type="button" className="file-ref" title={`${ref.path} を SAI で読む`} onClick={() => open(id, ref)}>
      <code>{text}</code>
    </button>
  )
}
