import type { Block } from '../../shared/markdown.ts'
import { Inlines } from './Inlines'
import { Lines } from './Lines'
import { MarkdownListItem } from './MarkdownListItem'

/** Markdown のブロック1つ（段落・見出し・箇条書き・コード・引用・罫線） */
export function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'paragraph':
      return <p><Lines lines={block.lines} /></p>
    case 'heading':
      return <div className={`heading h${block.level}`} role="heading" aria-level={block.level}><Inlines nodes={block.children} /></div>
    case 'list':
      return <ul>{block.items.map((item, i) => <MarkdownListItem key={i} item={item} />)}</ul>
    case 'code':
      return <pre data-lang={block.lang || undefined}><code>{block.text}</code></pre>
    case 'quote':
      return <blockquote><Lines lines={block.lines} /></blockquote>
    case 'rule':
      return <hr />
  }
}
