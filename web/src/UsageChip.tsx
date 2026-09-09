import { useEffect, useRef, useState } from 'react'
import { limitKindLabel, resetLabel, usageLevel, windowLabel } from '../../shared/usage.ts'
import { UsagePanel } from './UsagePanel'
import { useUsage } from './useUsage'

/**
 * ヘッダの使用量（#216）。Codex は 5 時間の枠の割合、Claude は**上限に当たっているときだけ**。
 * どちらも取れなければ何も出さない（Codex を使っていない人のヘッダに「不明」を並べない）。
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
  const level = codex ? usageLevel(codex.primary.used_percent) : 'ok'
  const title = [
    codex &&
      `Codex ${Math.round(codex.primary.used_percent)}%（${windowLabel(codex.primary.window_minutes)}）${codex.primary.resets_at ? ` · ${resetLabel(codex.primary.resets_at, at)}` : ''}`,
    codex?.secondary && `Codex ${Math.round(codex.secondary.used_percent)}%（${windowLabel(codex.secondary.window_minutes)}）`,
    claude && `Claude ${limitKindLabel(claude.kind)}の上限中 · ${resetLabel(claude.resets_at, at)}`,
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
        {claude && (
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
