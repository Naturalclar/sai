import { useState } from 'react'

interface Props {
  /** そのターンの思考。空なら何も出さない */
  text: string
  /** ページ全体の「思考を全部開く」。変わったらこのバブルの個別の開閉は忘れる */
  openAll: boolean
}

/**
 * エージェントのバブルの本文の上に出す、思考の折りたたみ。「▸ 思考（N 文字）」を押すと開く。
 * 思考は箇条書きや `**` が多く Markdown にすると崩れるので、打たれたまま（pre-wrap）で薄く出す
 */
export function ThinkingBlock({ text, openAll }: Props) {
  // 個別に押した開閉。null なら「全部開く」に従う。全部開くが切り替わったら個別の分は捨てる
  const [override, setOverride] = useState<boolean | null>(null)
  const [seenOpenAll, setSeenOpenAll] = useState(openAll)
  if (seenOpenAll !== openAll) {
    setSeenOpenAll(openAll)
    setOverride(null)
  }
  const open = override ?? openAll
  if (!text) return null
  return (
    <div className="thinking">
      <button type="button" className="think-toggle" onClick={() => setOverride(!open)} aria-expanded={open}>
        {open ? '▾' : '▸'} 思考（{text.length} 文字）
      </button>
      {open && <div className="think-body">{text}</div>}
    </div>
  )
}
