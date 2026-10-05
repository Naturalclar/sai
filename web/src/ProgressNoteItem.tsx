import { useState } from 'react'
import type { ProgressNote } from './api'
import { hm } from './format'
import { Markdown } from './Markdown'
import { isLongNote } from './noteClamp.ts'

/** 途中の文の 1 つ（#680）。長いものは畳んで出し、押すと全文 */
export function ProgressNoteItem({ note }: { note: ProgressNote }) {
  const [open, setOpen] = useState(false)
  const long = isLongNote(note.text)
  return (
    <li>
      <span className="when">{hm(note.at)}</span>
      <div className="said">
        <div className={`body${long && !open ? ' clamped' : ''}`}><Markdown text={note.text} /></div>
        {long && (
          <button type="button" className="linkish" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? '畳む' : '全文'}
          </button>
        )}
      </div>
    </li>
  )
}
