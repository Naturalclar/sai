import { fileSizeLabel } from '../../shared/attachments.ts'
import { FileMark } from './FileMark'
import type { Attached } from './useAttachments'
import { useState } from 'react'
import { pasteLabel, pastePreview } from '../../shared/pasteFile.ts'

interface Props {
  items: Attached[]
  onRemove: (path: string) => void
  disabled?: boolean
  /** ファイルにした貼り付け（#609）を本文に戻す。渡さなければ「本文に戻す」は出ない */
  onRestorePaste?: (item: Attached) => void
}

/** 入力欄の上に出る、これから送る添付。画像はサムネイル、ほかのファイル（#608）は印・名前・大きさ。✕ で外す */
export function AttachmentStrip({ items, onRemove, disabled, onRestorePaste }: Props) {
  // 中身を確かめている貼り付け（パス）。外したら自然に閉じる
  const [peek, setPeek] = useState('')
  if (items.length === 0) return null
  const shown = items.find((a) => a.path === peek && a.pasted)
  const preview = shown?.pasted ? pastePreview(shown.pasted.text) : null
  return (
    <>
      <div className="attachments" aria-label="添える画像・ファイル">
        {items.map((a) =>
          a.kind ? (
            <span className="thumb file" key={a.path}>
              {a.pasted ? (
                // ファイルにした貼り付け（#609）。押すと中身を確かめられる
                <button type="button" className="file-chip pasted" aria-expanded={peek === a.path} onClick={() => setPeek(peek === a.path ? '' : a.path)} title="押すと中身を確かめる">
                  <FileMark />
                  <span className="name">{pasteLabel(a.pasted.chars)}</span>
                </button>
              ) : (
                <span className="file-chip">
                  <FileMark />
                  <span className="name">{a.name || (a.kind === 'pdf' ? 'PDF' : 'テキスト')}</span>
                  <span className="kind">{[a.kind === 'pdf' ? 'PDF' : 'テキスト', a.size !== undefined ? fileSizeLabel(a.size) : ''].filter(Boolean).join(' · ')}</span>
                </span>
              )}
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
      {shown && preview && (
        <div className="paste-preview">
          <pre>{preview.head}</pre>
          <div className="foot">
            {preview.rest > 0 && <span className="rest">…あと {preview.rest.toLocaleString('en-US')} 字</span>}
            {onRestorePaste && (
              <button type="button" disabled={disabled} onClick={() => onRestorePaste(shown)} title="ファイルにするのをやめて、入力欄の本文に入れ直す（送りはしない）">
                本文に戻す
              </button>
            )}
            <button type="button" onClick={() => setPeek('')}>閉じる</button>
          </div>
        </div>
      )}
    </>
  )
}
