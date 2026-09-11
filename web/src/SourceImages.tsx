import { useContext } from 'react'
import { imageRefs } from '../../shared/images.ts'
import { ImageSourceContext } from './imageContext'
import { MarkdownImage } from './MarkdownImage'

/** 一言が付いたバブルで、「詳細」を開かなくても元の本文の画像が見えるように一言の下に並べる（#321） */
export function SourceImages({ text }: { text: string }) {
  const urlOf = useContext(ImageSourceContext)
  const refs = urlOf ? imageRefs(text) : []
  if (refs.length === 0) return null
  return (
    <div className="md-images">
      {refs.map((r) => (
        <MarkdownImage key={r.src} src={r.src} alt={r.alt} />
      ))}
    </div>
  )
}
