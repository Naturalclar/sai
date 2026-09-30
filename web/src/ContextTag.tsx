import { contextLabel, contextTitle } from '../../shared/contextSize.ts'

/** コンテキストが大きくなりすぎた印（#441）。出すかどうかは headTags() が決める（閾値は shared/contextSize.ts） */
export function ContextTag({ tokens }: { tokens: number }) {
  return (
    <span className="tag context-warn" title={contextTitle(tokens)}>
      コンテキスト {contextLabel(tokens)}
    </span>
  )
}
