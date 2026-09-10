import { useEffect, useRef, useState } from 'react'
import { MODE_LABEL, modeSkipsRules, REPLY_MODES, shortReplyMode } from '../../shared/permissions.ts'
import type { ReplyPermissionMode } from '../../shared/types.ts'
import { api } from './api'

export interface ReplyPermissionProps {
  /** 返信先のエンティティID。ここに保存する */
  id: string
  /** いま設定されている許可モード。無ければ CLI の既定 */
  value: ReplyPermissionMode | undefined
  /** 端末（tmux）で開いているか。開いていると打ち込む経路になり、この設定は効かない */
  terminal: boolean
}

/**
 * 入力欄の、モデルの右に出す許可モード（#265）。押すとメニューが開き、選ぶとそのセッションの
 * 返信の許可モードが変わる（`PUT /api/sessions/<id>/meta` の `permission_mode`。次の返信から効く）。
 * 見出しにあった `<select>` から移したもので、**操作はここ 1 か所**（モデルと同じ形）。
 *
 * 並ぶのは `shared/permissions.ts` の `REPLY_MODES` で、サーバの検査と同じ一覧。
 * **素通し（bypassPermissions）を選んでいる間は赤くする**（#253。選んだまま忘れているのが一番まずい）。
 * 端末に打ち込む経路ではフラグを渡す先が無いので効かない（薄くして、その旨を title に出す）。
 * 呼び出し側は key={id} を付けること（別のセッションに移ったら開閉ごと作り直す）
 */
export function ReplyPermissionPicker({ id, value, terminal }: ReplyPermissionProps) {
  const [open, setOpen] = useState(false)
  // 保存直後の値（ポーリングが追いつくまで）。null ならまだ触っていない（props を見る）
  const [saved, setSaved] = useState<ReplyPermissionMode | '' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const current = saved !== null ? saved : (value ?? '')
  const loud = modeSkipsRules(current)

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

  const save = async (mode: string) => {
    setOpen(false)
    setBusy(true)
    setError('')
    try {
      // 空文字は「消す」（CLI の既定に従う）
      const res = await api.setMeta(id, { permission_mode: mode as ReplyPermissionMode })
      setSaved(res.meta.permission_mode ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      buttonRef.current?.focus()
    }
  }

  return (
    <div className={`perm-pick${terminal ? ' inactive' : ''}`} ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className={loud ? 'loud' : ''}
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="SAI から返信するときの許可モード"
        title={
          terminal
            ? `SAI から返信するときの許可モード: ${MODE_LABEL[current || 'default']}。いまは端末（tmux）で開いているので返信は端末に打ち込まれ、この設定は効かない（端末側は Shift+Tab で切り替える）`
            : `SAI から返信するときの許可モード: ${MODE_LABEL[current || 'default']}。押すと変えられる。そのターンだけに効き、セッションには残らない`
        }
      >
        {busy ? '…' : shortReplyMode(current)}
      </button>
      {open && (
        <div className="menu" role="menu">
          {/* ボタンの短い名前（`聞く`）と違って、メニューでは何が起きるかを書く */}
          <button type="button" role="menuitem" className={current ? '' : 'picked'} onClick={() => void save('')}>
            許可は既定（聞く）<span className="why">CLI に任せる</span>
          </button>
          {REPLY_MODES.map((m) => (
            <button
              type="button"
              role="menuitem"
              key={m}
              className={`${m === current ? 'picked' : ''}${modeSkipsRules(m) ? ' loud' : ''}`}
              onClick={() => void save(m)}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      )}
      {error && <span className="err">{error}</span>}
    </div>
  )
}
