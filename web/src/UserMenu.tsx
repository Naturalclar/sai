import { useEffect, useRef, useState } from 'react'
import type { Profile, Viewer } from './api'
import { ProfileEditor } from './ProfileEditor'

/**
 * ヘッダー右端の自分のアイコン。押すとメニュー（名前、「表示名とアイコン」）が開き、そこからモーダルで編集する。
 * profile は一覧のポーリング（App）から。編集直後はモーダルが返した値を出し、ポーリングが追いついたら props に戻る。
 * Esc と外側クリックで閉じる。設定が増えたらここに項目を足す
 */
export function UserMenu({ profile, viewer }: { profile: Profile | undefined; viewer: Viewer | null }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState<Profile | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const current = saved ?? profile ?? {}

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

  const edit = () => {
    setOpen(false)
    setEditing(true)
  }
  const closeEditor = (next?: Profile) => {
    if (next) setSaved(next)
    setEditing(false)
    buttonRef.current?.focus()
  }

  return (
    <div className="user-menu" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className="user"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="自分のメニュー"
        title={viewer ? `${current.name || viewer.name || 'あなた'}（${viewer.login} として tailnet 経由）` : current.name || 'あなた'}
      >
        <span className="avatar me">{current.icon ? <img src={current.icon} alt="" /> : '私'}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="who">
            {current.name || viewer?.name || 'あなた'}
            {/* tailnet 経由（tailscale serve）のときだけ。Serve のヘッダを whois で確かめた後のログイン名 */}
            {viewer && <span className="login" title="tailscale serve 経由。Tailscale のログイン名">{viewer.login}</span>}
          </div>
          <button type="button" role="menuitem" onClick={edit}>
            表示名とアイコン
          </button>
        </div>
      )}
      {editing && <ProfileEditor profile={current} onClose={closeEditor} />}
    </div>
  )
}
