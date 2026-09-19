import { useState } from 'react'
import type { BackgroundSession } from '../../shared/types.ts'
import { attachCommand, backgroundNote } from './backgroundAttach'

interface Props {
  background: BackgroundSession
}

/**
 * `claude --bg` のセッション（#462）なら、端末で開くコマンドと状態を出す。
 * **許可・質問は画面から答えられない**ので、待っているときは目立たせる
 */
export function BackgroundAttachBar({ background }: Props) {
  const [copied, setCopied] = useState(false)
  const command = attachCommand(background)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // http（tailnet の外の素の IP など）では clipboard が使えない。コマンドは選んでコピーできる
    }
  }
  return (
    <div className={`bg-attach${background.status === 'waiting' ? ' waiting' : ''}`}>
      <span className="title">バックグラウンド</span>
      <code>{command}</code>
      <button type="button" onClick={() => void copy()}>{copied ? 'コピーしました' : 'コピー'}</button>
      <span className="note">{backgroundNote(background)}</span>
    </div>
  )
}
