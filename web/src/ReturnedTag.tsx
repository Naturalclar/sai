import { md } from './format'

/** アーカイブしたあとも行が増えて、一覧に戻ってきたセッションの印（#583）。出すかは `returnedFromArchive()` が決める */
export function ReturnedTag({ at }: { at: string }) {
  return (
    <span className="tag returned" title={`${md(at)} にアーカイブしたあとも、このセッションに返信が続いています`}>
      アーカイブ後も継続
    </span>
  )
}
