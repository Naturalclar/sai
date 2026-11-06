import { useEffect, useRef, useState } from 'react'
import type { Block } from '../../shared/markdown.ts'
import { CODE_COPIED_MS, codeCopyText, codeCopyView, type CodeCopyState } from './codeCopy.ts'
import { CopyMark } from './CopyMark'
import { copyText } from './messageLink.ts'

/**
 * 返答のコードブロック（` ``` `）。右上のボタンで中身をクリップボードに入れる（#877）。
 * - ボタンは `pre` の横の別の列に置く（中身に重ねない。横に長い行を送っても隠れない）。携帯で押せるよういつも見せる
 * - 書くのは押したときだけ。書けなければ（`navigator.clipboard` が無い素の IP の http など）ブロックの下に案内を出す
 */
export function CodeBlock({ block }: { block: Extract<Block, { kind: 'code' }> }) {
  const [state, setState] = useState<CodeCopyState>('idle')
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = async () => {
    window.clearTimeout(timer.current)
    const ok = await copyText(codeCopyText(block))
    setState(ok ? 'copied' : 'failed')
    if (ok) timer.current = window.setTimeout(() => setState('idle'), CODE_COPIED_MS)
  }
  const view = codeCopyView(state)
  return (
    <div className="code-block">
      <div className="code-wrap">
        <pre data-lang={block.lang || undefined}><code>{block.text}</code></pre>
        <button type="button" className={`code-copy${state === 'copied' ? ' done' : ''}`} onClick={() => void copy()} aria-label={view.label} title={view.label}>
          <CopyMark done={state === 'copied'} />
        </button>
      </div>
      {view.note && <div className="code-copy-note" role="status">{view.note}</div>}
    </div>
  )
}
