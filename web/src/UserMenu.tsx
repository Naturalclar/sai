import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Profile, Viewer } from './api'
import { ProfileEditor } from './ProfileEditor'
import { useDismiss } from './useDismiss'
import type { useNotify } from './useNotify'

interface Props {
  profile: Profile | undefined
  viewer: Viewer | null
  /** 待ちの通知の入切（#231）。入にした時だけブラウザの許可を求める */
  notify: ReturnType<typeof useNotify>
  /** メニューの末尾に足すもの。一言の入切・口・モデル（#288）と、狭い画面では一言の性格・Linear の設定もここに入る（#274） */
  children?: ReactNode
}

/**
 * ヘッダー右端の自分のアイコン。押すとメニュー（名前、「表示名とアイコン」、通知の入切）が開き、
 * そこからモーダルで編集する。
 * profile は一覧のポーリング（App）から。編集直後はモーダルが返した値を出し、ポーリングが追いついたら props に戻る。
 * Esc と外側クリックで閉じる（useDismiss）。設定が増えたらここに項目を足す
 */
export function UserMenu({ profile, viewer, notify, children }: Props) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState<Profile | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const current = saved ?? profile ?? {}

  useDismiss(ref, open, setOpen)

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
          {/* 待ちの通知。ブラウザが拒否を覚えている間は押しても出せないので、その旨だけ出す */}
          {notify.state === 'denied' ? (
            <div className="note">通知はブラウザ側で拒否されています（サイトの設定から許可してください）</div>
          ) : notify.state === 'unsupported' ? (
            <div className="note">この環境では通知を出せません</div>
          ) : (
            <button type="button" role="menuitemcheckbox" aria-checked={notify.on} onClick={() => void notify.toggle()}>
              {notify.on ? '✓ ' : ''}待っているときに通知する
            </button>
          )}
          {children}
        </div>
      )}
      {editing && <ProfileEditor profile={current} onClose={closeEditor} />}
    </div>
  )
}
