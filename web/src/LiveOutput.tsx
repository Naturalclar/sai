import { useEffect, useRef, useState, type UIEvent } from 'react'
import { api } from './api'
import type { TurnOutputResponse } from './api'
import { OutputSection } from './OutputSection'
import { pollLoop } from './pollLoop.ts'

/** 開いている間の取り直しの間隔（前の要求が返ってから。一覧の 3 秒のポーリングとは別） */
export const LIVE_OUTPUT_POLL_MS = 2_000

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'open'; data: TurnOutputResponse }

/**
 * 走っている Codex のコマンドの途中の出力（#846 の 2 つ目）。処理中の手順の「走っているコマンド」の横に出す。
 * **押したときだけ**読み、開いている間だけ `pollLoop()` で取り直す（閉じる・ターンが終わって消えると止まる）。
 * 中身は秘密を含みうるので、保存しない。文字として描く（`OutputSection`）
 */
export function LiveOutput({ id }: { id: string }) {
  const [shown, setShown] = useState(false)
  const [state, setState] = useState<State>({ kind: 'loading' })
  useEffect(() => {
    if (!shown) return
    let alive = true
    const tick = async () => {
      // 隠れているタブでは取らない（戻ったら次の周期で取る）
      if (document.hidden) return
      try {
        const data = await api.liveOutput(id)
        if (alive) setState({ kind: 'open', data })
      } catch (err: unknown) {
        if (alive) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    }
    // 開いた直後に 1 回、そのあと返ってから 2 秒ごと（`pollLoop` は作ったときに 1 回回す）
    const loop = pollLoop(tick, () => LIVE_OUTPUT_POLL_MS)
    return () => {
      alive = false
      loop.stop()
    }
  }, [shown, id])
  // 新しい出力が来たら下端に寄せる（最新の行が下にあるので）。人が上へ戻した欄は追わない（下端に戻すとまた追う）
  const box = useRef<HTMLDivElement>(null)
  const data = state.kind === 'open' ? state.data : null
  useEffect(() => {
    if (!data?.found) return
    for (const pre of box.current?.querySelectorAll('pre') ?? []) if (pre.dataset.free !== '1') pre.scrollTop = pre.scrollHeight
  }, [data])
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const pre = e.target
    if (!(pre instanceof HTMLElement) || pre.tagName !== 'PRE') return
    pre.dataset.free = pre.scrollHeight - pre.scrollTop - pre.clientHeight > 24 ? '1' : ''
  }
  const toggle = () => {
    if (!shown) setState({ kind: 'loading' })
    setShown((v) => !v)
  }
  return (
    <div className="step-output live-output" ref={box} onScrollCapture={onScroll}>
      <button type="button" className="linkish" aria-expanded={shown} onClick={toggle}>
        {shown ? '途中の出力を閉じる' : '途中の出力'}
      </button>
      {shown && state.kind === 'loading' && <div className="note">読み込み中…</div>}
      {shown && state.kind === 'error' && <div className="note err">{state.message}</div>}
      {shown && data && !data.found && <div className="note">走っているコマンドはありません（終わった出力は、ターンが終わったあと手順から開けます）</div>}
      {shown && data?.found && data.sections.map((s, i) => <OutputSection key={`${s.label}:${i}`} section={s} />)}
    </div>
  )
}
