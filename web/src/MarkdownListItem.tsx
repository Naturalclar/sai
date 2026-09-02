import type { ListItem } from '../../shared/markdown.ts'
import { Lines } from './Lines'

/** 箇条書きの1項目。記号は `1.` `2)` はそのまま、`-` `*` `+` は深さで • / ◦ */
export function MarkdownListItem({ item }: { item: ListItem }) {
  const marker = /\d/.test(item.marker) ? item.marker : item.depth % 2 === 0 ? '•' : '◦'
  return (
    <li style={item.depth ? { marginLeft: `${item.depth * 1.4}em` } : undefined}>
      <span className="marker">{marker}</span>
      <span className="item"><Lines lines={item.lines} /></span>
    </li>
  )
}
