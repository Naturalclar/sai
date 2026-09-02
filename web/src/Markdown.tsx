import { parseMarkdown } from '../../shared/markdown.ts'
import { BlockView } from './BlockView'

/**
 * text を Markdown として描く。パースは shared/markdown.ts。
 * HTML 文字列を組み立てず React 要素にするので dangerouslySetInnerHTML は使わない。
 * リンクは別タブで開く（SAI は 127.0.0.1 なので同じタブで遷移すると戻るのが面倒）。
 */
export function Markdown({ text }: { text: string }) {
  return (
    <>
      {parseMarkdown(text).map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </>
  )
}
