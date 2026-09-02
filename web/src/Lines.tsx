import { Fragment } from 'react'
import type { Inline } from '../../shared/markdown.ts'
import { Inlines } from './Inlines'

/** 段落内の行。white-space: pre-wrap なので改行文字で改行する */
export function Lines({ lines }: { lines: Inline[][] }) {
  return lines.map((line, i) => (
    <Fragment key={i}>
      {i > 0 && '\n'}
      <Inlines nodes={line} />
    </Fragment>
  ))
}
