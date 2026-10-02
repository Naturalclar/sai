import { useState } from 'react'
import { api } from './api'
import { LOOP_DEFAULT_HOURS, LOOP_DEFAULT_INTERVAL_S, LOOP_DEFAULT_ROUNDS, LOOP_MAX_HOURS, LOOP_MAX_INTERVAL_S, LOOP_MAX_ROUNDS, LOOP_MIN_INTERVAL_S, LOOP_TEXT_MAX } from '../../shared/loops.ts'

interface Props {
  /** 組む先のセッション */
  id: string
  onClose: () => void
}

/**
 * ループを組む（#634）。**目的と終わりの条件は人が書く**（空では組めない）。上限（周の数・時間）は既定値が入っていて、
 * 上限なしにはできない。次にいつ起きるか・終わったかは、エージェントが周の終わりに言う
 */
export function LoopForm({ id, onClose }: Props) {
  const [goal, setGoal] = useState('')
  const [until, setUntil] = useState('')
  const [rounds, setRounds] = useState(String(LOOP_DEFAULT_ROUNDS))
  const [hours, setHours] = useState(String(LOOP_DEFAULT_HOURS))
  const [minutes, setMinutes] = useState(String(LOOP_DEFAULT_INTERVAL_S / 60))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ready = goal.trim() !== '' && until.trim() !== '' && !busy
  const start = async () => {
    setBusy(true)
    setError('')
    try {
      await api.startLoop(id, { goal, until, max_rounds: Number(rounds), hours: Number(hours), interval_s: Math.round(Number(minutes) * 60) })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  return (
    <form
      className="loop-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) void start()
      }}
    >
      <div className="title">ループを組む</div>
      <div className="hint">目的に向かって何周も回します。次にいつ起きるか・終わったかはエージェントが周の終わりに言い、上限は SAI が止めます。組むとすぐ 1 周目を送ります</div>
      <label>
        目的
        <textarea value={goal} maxLength={LOOP_TEXT_MAX} rows={2} onChange={(e) => setGoal(e.target.value)} placeholder="例: open な PR を見て、マージできるものをマージする" />
      </label>
      <label>
        終わりの条件（確かめられる形で）
        <textarea value={until} maxLength={LOOP_TEXT_MAX} rows={2} onChange={(e) => setUntil(e.target.value)} placeholder="例: open な PR が 0 件になった" />
      </label>
      <div className="limits">
        <label>
          上限
          <input type="number" inputMode="numeric" min={1} max={LOOP_MAX_ROUNDS} step={1} value={rounds} onChange={(e) => setRounds(e.target.value)} />周
        </label>
        <label>
          <input type="number" inputMode="decimal" min={0.1} max={LOOP_MAX_HOURS} step={0.1} value={hours} onChange={(e) => setHours(e.target.value)} />時間まで
        </label>
        <label>
          既定の間隔
          <input type="number" inputMode="decimal" min={LOOP_MIN_INTERVAL_S / 60} max={LOOP_MAX_INTERVAL_S / 60} step={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} />分
        </label>
      </div>
      {error && <div className="err">{error}</div>}
      <div className="actions">
        <button type="button" onClick={onClose} disabled={busy}>
          やめる
        </button>
        <button type="submit" className="primary" disabled={!ready}>
          組んで 1 周目を送る
        </button>
      </div>
    </form>
  )
}
