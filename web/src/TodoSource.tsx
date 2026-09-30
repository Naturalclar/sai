import { useState } from 'react'
import { Markdown } from './Markdown'
import { ClippedNote } from './ClippedNote'
import { ImageSourceContext } from './imageContext'
import { wasClipped } from '../../shared/clipped.ts'
import { isLong } from './longText.ts'
import { useTurnText } from './useTurnText'

/**
 * 要対応の「終了」の行の下に開く、一言（要約）のもとの本文（#537）。開いたときだけ取る。
 * 描き方はバブルの「詳細」と同じ Markdown で、長ければ折りたたむ。画像は印と名前だけ（行の中に画像の口は無い。一言と同じ扱い）
 */
export function TodoSource({ id, ts }: { id: string; ts: string }) {
  const got = useTurnText(id, ts)
  const [open, setOpen] = useState(false)
  if (got.state === 'loading') return <div className="todo-source note">読み込み中…</div>
  if (got.state === 'error') return <div className="todo-source note">元の文を取れませんでした</div>
  const text = got.row?.text ?? ''
  if (!text) return <div className="todo-source note">元の文が見つかりません（記録の窓から外れたか、本文の無いターンです）</div>
  const long = isLong(text)
  return (
    <div className="todo-source">
      <div className={`body${long && !open ? ' clamped' : ''}`}>
        <ImageSourceContext value={null}>
          <Markdown text={text} />
        </ImageSourceContext>
      </div>
      {long && (
        <button type="button" className="linkish more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '折りたたむ' : 'もっと見る'}
        </button>
      )}
      {got.row && wasClipped(got.row, 'text') && <ClippedNote />}
    </div>
  )
}
