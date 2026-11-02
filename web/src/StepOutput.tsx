import { useState } from 'react'
import { api } from './api'
import type { TurnOutputResponse } from './api'
import { OutputSection } from './OutputSection'

type State = { kind: 'closed' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'open'; data: TurnOutputResponse }

/**
 * 手順の 1 つの出力・差分（#846）。**押したときに 1 回だけ**取る（ポーリングには乗せない）。
 * 中身は秘密を含みうるので、閉じても消さないのは同じ画面の中だけ（保存しない）
 */
export function StepOutput({ id, ts, outputRef, kind }: { id: string; ts: string; outputRef: string; kind: 'output' | 'diff' }) {
  const [state, setState] = useState<State>({ kind: 'closed' })
  const [shown, setShown] = useState(false)
  const name = kind === 'diff' ? '差分' : '出力'
  const toggle = () => {
    if (shown) return setShown(false)
    setShown(true)
    if (state.kind === 'open' || state.kind === 'loading') return
    setState({ kind: 'loading' })
    api
      .turnOutput(id, ts, outputRef)
      .then((data) => setState({ kind: 'open', data }))
      .catch((err: unknown) => setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }))
  }
  const data = state.kind === 'open' ? state.data : null
  return (
    <div className="step-output">
      <button type="button" className="linkish" aria-expanded={shown} onClick={toggle}>
        {shown ? `${name}を閉じる` : name}
      </button>
      {shown && state.kind === 'loading' && <div className="note">読み込み中…</div>}
      {shown && state.kind === 'error' && <div className="note err">{state.message}</div>}
      {shown && data && !data.found && <div className="note">記録がありません（まだ終わっていない・要約で消えた・別のマシンのセッション）</div>}
      {shown && data?.found && data.sections.map((s, i) => <OutputSection key={`${s.label}:${i}`} section={s} />)}
      {shown && (data?.more ?? 0) > 0 && <div className="note">ほか {data?.more} 件（頭の {data?.sections.length} 件だけ出しています）</div>}
    </div>
  )
}
