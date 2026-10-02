import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FileRef } from '../../shared/files.ts'
import type { SessionFileResponse } from '../../shared/types.ts'
import { api } from './api'
import { CloseMark } from './CloseMark'
import { FileSessionContext } from './fileContext'
import { FILE_LINE_H, fileLines, fileSizeLabel, initialMode, isMarkdownFile, lineNumbers, scrollTopFor, targetLine, type FileMode } from './fileView'
import { IconButton } from './IconButton'
import { ImageSourceContext } from './imageContext'
import { Markdown } from './Markdown'

/**
 * 返答に出てきたファイルを読む（#603）。**読むだけ**で、文字のファイルだけ（サーバが決める）。
 * - `.md` は今の `Markdown` で描いた形と元の文字を切り替える。ほかは等幅で行番号つき。**HTML は描かない**（文字として見せるだけ）
 * - `path:行` で開いたときは、その行に印を付けてそこまで流す
 * - 読めないとき（無い・作業ディレクトリの外・大きすぎる・文字でない・名前で断るもの・tailnet 越し）は、サーバの理由を 1 行出す
 * - 中の Markdown では、ファイルと画像の口を切る（相対パスの基準がそのファイルの場所で、セッションの cwd ではない）
 * Esc・背景・✕ で閉じる。キーは capture で止める（App の Esc =「フィードへ」まで動かさない。ライトボックスと同じ）
 */
export function FileViewer({ id, file, onClose }: { id: string; file: FileRef; onClose: () => void }) {
  const [data, setData] = useState<SessionFileResponse | null>(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<FileMode>(() => initialMode(file))
  const closeRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 開いたときに 1 回だけ読む（別のファイルは Provider が key で作り直す）
  useEffect(() => {
    let alive = true
    api.sessionFile(id, file.path).then(
      (d) => alive && setData(d),
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      alive = false
    }
  }, [id, file.path])

  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => back?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      onClose()
      e.preventDefault()
      e.stopPropagation()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const lines = useMemo(() => (data ? fileLines(data.text) : []), [data])
  const target = targetLine(file.line, lines.length)
  // 指した行まで流す（元の文字で出しているときだけ）
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && data && mode === 'raw' && target) el.scrollTop = scrollTopFor(target, el.clientHeight)
  }, [data, mode, target])

  const name = data?.name ?? file.path.split('/').pop() ?? file.path
  const markdown = isMarkdownFile(name)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal file-viewer" role="dialog" aria-modal="true" aria-label={`ファイル: ${name}`}>
        <div className="file-head">
          <span className="name" title={file.path}>{name}</span>
          <code className="path">{file.line ? `${file.path}:${file.line}` : file.path}</code>
          {data && <span className="size">{lines.length} 行 · {fileSizeLabel(data.bytes)}</span>}
          {data && markdown && (
            <button type="button" className="linkish mode" onClick={() => setMode(mode === 'raw' ? 'rendered' : 'raw')}>
              {mode === 'raw' ? '描いた形で見る' : '元の文字で見る'}
            </button>
          )}
          <IconButton label="閉じる" onClick={onClose} ref={closeRef}>
            <CloseMark />
          </IconButton>
        </div>
        <div className="file-scroll" ref={scrollRef}>
          {error && <div className="empty">開けません: {error}</div>}
          {!data && !error && <div className="empty">読んでいます…</div>}
          {data && mode === 'rendered' && (
            <div className="file-md body">
              <FileSessionContext value={null}>
                <ImageSourceContext value={null}>
                  <Markdown text={data.text} />
                </ImageSourceContext>
              </FileSessionContext>
            </div>
          )}
          {data && mode === 'raw' && (
            <div className="file-raw">
              {target > 0 && <div className="file-target" style={{ top: (target - 1) * FILE_LINE_H }} />}
              <pre className="nos" aria-hidden="true">{lineNumbers(lines.length)}</pre>
              <pre className="src">{lines.join('\n')}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
