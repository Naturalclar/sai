import { Fragment } from 'react'
import type { Inline } from '../../shared/markdown.ts'
import { MarkdownImage } from './MarkdownImage'

/** 行の中身（文字・コード・絵文字・太字・リンク・画像）。太字とリンクは中に自分を含む */
export function Inlines({ nodes }: { nodes: Inline[] }) {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case 'text':
        return <Fragment key={i}>{node.text}</Fragment>
      case 'code':
        return <code key={i}>{node.text}</code>
      case 'emoji':
        // 元の名前を title に出す（Slack と同じ。何の絵文字か分かる）
        return <span key={i} className="emoji" title={`:${node.name}:`}>{node.char}</span>
      case 'strong':
        return <strong key={i}><Inlines nodes={node.children} /></strong>
      case 'link':
        return (
          <a key={i} href={node.href} target="_blank" rel="noopener noreferrer">
            <Inlines nodes={node.children} />
          </a>
        )
      case 'image':
        // 手元のファイルの画像への参照（#321）。今までは `[名前](/Users/…)` の Markdown がそのまま文字で出ていた。
        // key にパスを混ぜる（読めなかった印を、同じ位置に来た別の画像に持ち越さない）
        return <MarkdownImage key={`${i}:${node.src}`} src={node.src} alt={node.alt} />
    }
  })
}
