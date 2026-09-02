import { Fragment } from 'react'
import { parseMarkdown, type Block, type Inline, type ListItem } from '../../shared/markdown.ts'

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

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'paragraph':
      return <p><Lines lines={block.lines} /></p>
    case 'heading':
      return <div className={`heading h${block.level}`} role="heading" aria-level={block.level}><Inlines nodes={block.children} /></div>
    case 'list':
      return <ul>{block.items.map((item, i) => <Item key={i} item={item} />)}</ul>
    case 'code':
      return <pre data-lang={block.lang || undefined}><code>{block.text}</code></pre>
    case 'quote':
      return <blockquote><Lines lines={block.lines} /></blockquote>
    case 'rule':
      return <hr />
  }
}

/** 記号は `1.` `2)` はそのまま、`-` `*` `+` は深さで • / ◦ */
function Item({ item }: { item: ListItem }) {
  const marker = /\d/.test(item.marker) ? item.marker : item.depth % 2 === 0 ? '•' : '◦'
  return (
    <li style={item.depth ? { marginLeft: `${item.depth * 1.4}em` } : undefined}>
      <span className="marker">{marker}</span>
      <span className="item"><Lines lines={item.lines} /></span>
    </li>
  )
}

/** 段落内の行。white-space: pre-wrap なので改行文字で改行する */
function Lines({ lines }: { lines: Inline[][] }) {
  return lines.map((line, i) => (
    <Fragment key={i}>
      {i > 0 && '\n'}
      <Inlines nodes={line} />
    </Fragment>
  ))
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case 'text':
        return <Fragment key={i}>{node.text}</Fragment>
      case 'code':
        return <code key={i}>{node.text}</code>
      case 'strong':
        return <strong key={i}><Inlines nodes={node.children} /></strong>
      case 'link':
        return (
          <a key={i} href={node.href} target="_blank" rel="noopener noreferrer">
            <Inlines nodes={node.children} />
          </a>
        )
    }
  })
}
