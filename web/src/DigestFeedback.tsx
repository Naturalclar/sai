import { useState } from 'react'
import { api } from './api'
import { DIGEST_FEEDBACK_REASONS, DIGEST_NOTE_MAX } from '../../shared/digestFeedback.ts'
import type { DigestFeedbackReason } from '../../shared/digestFeedback.ts'

/**
 * 一言（digest）が変だと言う口（#346）。押すと理由を選べて、任意で「こうしてほしい」を書ける。
 *
 * **その場の一言は変わらない**（作り直しはしない）。`~/.agent-feed/digest-feedback.jsonl` に溜めて、
 * 規則を直すときの材料と回帰テストの素材にする。溜めたものは外には出さない
 */
export function DigestFeedback({ digestKey }: { digestKey: string }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  if (done) return <span className="digest-fb done" title="~/.agent-feed/digest-feedback.jsonl に残した">覚えた</span>

  const send = async (reason: DigestFeedbackReason) => {
    setError('')
    try {
      await api.digestFeedback(digestKey, reason, note.trim() || undefined)
      setOpen(false)
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <span className="digest-fb">
      <button type="button" className="linkish" onClick={() => setOpen((v) => !v)} aria-expanded={open} title="この一言が変だと残す（一言は変わらない）">
        {open ? '閉じる' : '変？'}
      </button>
      {open && (
        <span className="panel">
          <input
            type="text"
            value={note}
            maxLength={DIGEST_NOTE_MAX}
            placeholder="こうしてほしい（任意）"
            onChange={(e) => setNote(e.target.value)}
          />
          <span className="reasons">
            {DIGEST_FEEDBACK_REASONS.map((r) => (
              <button type="button" key={r.id} onClick={() => void send(r.id)}>{r.label}</button>
            ))}
          </span>
          {error && <span className="err">{error}</span>}
        </span>
      )}
    </span>
  )
}
