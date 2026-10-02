import { useCallback, useState, type ReactNode } from 'react'
import type { FileRef } from '../../shared/files.ts'
import { FileOpenContext } from './fileContext'
import { FileViewer } from './FileViewer'

/** 返答の中のファイルを、ページの中で開けるようにする（#603）。開いているファイルはここが 1 つだけ持つ */
export function FileViewerProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<{ id: string; ref: FileRef } | null>(null)
  const open = useCallback((id: string, ref: FileRef) => setShown({ id, ref }), [])
  const close = useCallback(() => setShown(null), [])
  return (
    <FileOpenContext value={open}>
      {children}
      {shown && <FileViewer key={`${shown.id}\n${shown.ref.path}\n${shown.ref.line}`} id={shown.id} file={shown.ref} onClose={close} />}
    </FileOpenContext>
  )
}
