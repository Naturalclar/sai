import { useEffect, useRef, useState } from 'react'
import { limitKindLabel, resetLabel, windowLabel } from '../../shared/usage.ts'
import type { UsageWindow } from './api'
import { UsagePanel } from './UsagePanel'
import { chipsLevel, usageChips } from './usageChips'
import { useUsage } from './useUsage'

/**
 * ヘッダの使用量（#216 / #250）。5 時間の枠の割合を出し、**Claude は 5 時間が無ければ週に落とす**（#347）。
 * Claude の割合はステータスラインを設定している人だけ取れるので、無ければ「上限中」のときだけ出す。
 * 何も取れなければ何も出さない（使っていない人のヘッダに「不明」を並べない）。
 * 押すと詳細のパネルが開き、そのときに取り直す。Esc と外側クリックで閉じる
 */
export function UsageChip() {
  const { usage, at, reload } = useUsage()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!usage || (!usage.codex && !usage.claude)) return null

  const codex = usage.codex
  const claude = usage.claude
  // 何をどの順で出すか（Claude が先、5 時間が無ければ週）と色は usageChips.ts に 1 つだけ置く（#347）
  const chips = usageChips(usage)
  const level = chipsLevel(chips)
  const line = (name: string, w: UsageWindow) =>
    `${name} ${Math.round(w.used_percent)}%（${windowLabel(w.window_minutes)}）${w.resets_at ? ` · ${resetLabel(w.resets_at, at)}` : ''}`
  const title = [
    codex && line('Codex', codex.primary),
    codex?.secondary && line('Codex', codex.secondary),
    claude?.primary && line('Claude', claude.primary),
    claude?.secondary && line('Claude', claude.secondary),
    claude?.limited && `Claude ${limitKindLabel(claude.limited.kind)}の上限中 · ${resetLabel(claude.limited.resets_at, at)}`,
  ]
    .filter(Boolean)
    .join('\n')

  const toggle = () => {
    if (!open) reload()
    setOpen((v) => !v)
  }

  return (
    <div className="usage" ref={ref}>
      <button type="button" className={`usage-chip ${level}`} onClick={toggle} aria-expanded={open} aria-label="使用量" title={title}>
        {/* 狭い画面ではエージェント名を落として色の点だけにする（ヘッダの 1 行に収める）。週の印は狭くても残す */}
        {chips.map((c) => (
          <span key={c.agent} className={`usage-part${c.limited ? ' hit' : ''}`}>
            <span className={`dot ${c.agent}`} />
            <span className="usage-name">{c.name}</span>{' '}
            {c.percent === null ? '上限中' : <b>{Math.round(c.percent)}%</b>}
            {c.week && <span className="usage-window">週</span>}
          </span>
        ))}
      </button>
      {open && <UsagePanel usage={usage} now={at} />}
    </div>
  )
}
