import { useEffect, useRef, useState } from 'react'
import { limitKindLabel, resetLabel, usageLevel, windowLabel } from '../../shared/usage.ts'
import type { UsageWindow } from './api'
import { UsagePanel } from './UsagePanel'
import { useUsage } from './useUsage'

/** 色の強さの順。複数の枠のうち一番きついものを採る */
const RANK = { ok: 0, warn: 1, high: 2 } as const

/**
 * ヘッダの使用量（#216 / #250）。どちらのエージェントも 5 時間の枠の割合を出す。
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
  // 色は「一番きつい枠」に合わせる（片方が 95% ならヘッダは赤くする）
  const level = [codex?.primary.used_percent, claude?.primary?.used_percent]
    .filter((p): p is number => typeof p === 'number')
    .reduce<'ok' | 'warn' | 'high'>((worst, p) => (RANK[usageLevel(p)] > RANK[worst] ? usageLevel(p) : worst), 'ok')
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
        {/* 狭い画面ではエージェント名を落として色の点だけにする（ヘッダの 1 行に収める） */}
        {codex && (
          <span className="usage-part">
            <span className="dot codex" />
            <span className="usage-name">Codex</span> <b>{Math.round(codex.primary.used_percent)}%</b>
          </span>
        )}
        {claude?.primary && (
          <span className={`usage-part${claude.limited ? ' hit' : ''}`}>
            <span className="dot claude" />
            <span className="usage-name">Claude</span> <b>{Math.round(claude.primary.used_percent)}%</b>
          </span>
        )}
        {claude && !claude.primary && claude.limited && (
          <span className="usage-part hit">
            <span className="dot claude" />
            <span className="usage-name">Claude</span> 上限中
          </span>
        )}
      </button>
      {open && <UsagePanel usage={usage} now={at} />}
    </div>
  )
}
