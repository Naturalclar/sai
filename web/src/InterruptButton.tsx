import { useState } from 'react'
import { api } from './api'

/**
 * 処理中のターンを止める（#384）。仮バブルの「処理中 N 分」の横に出す。
 *
 * **出すのは `Replying.interruptible` が付いているときだけ**（SAI の app-server が回している Codex のターン、
 * SAI が起こした `opencode serve` が回している OpenCode のターン（#392）、入力の口を開けている `claude -p` のターン（#386））。
 * 端末で打ったターンと、立て直しで引き取った `claude -p` には止める口が無いので出さない。
 * 押すとサーバが Codex には `turn/interrupt`、OpenCode には `/session/<id>/abort`、Claude には `control_request` の `interrupt` を投げ、**預かった返信は止まる**（勝手に次が走らない。「続けて送る」で人が回す）。
 * 消えるのは次のポーリングで `replying` から外れたとき
 */
export function InterruptButton({ id }: { id: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const stop = async () => {
    setBusy(true)
    setError('')
    try {
      await api.interrupt(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        type="button"
        className="interrupt"
        disabled={busy}
        onClick={() => void stop()}
        title="このターンを止める。預かった返信は止めたままにするので、続けるなら「続けて送る」を押す"
      >
        {busy ? '止めています…' : '止める'}
      </button>
      {error && <span className="interrupt-error">{error}</span>}
    </>
  )
}
