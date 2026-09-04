import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { ICON_ACCEPT, ICON_MIME, ICON_SOURCE_MAX_BYTES } from '../../shared/icon.ts'
import { META_NAME_MAX } from '../../shared/meta.ts'
import { mergeProfile } from '../../shared/profile.ts'
import { api, type Profile } from './api'
import { IconCropper } from './IconCropper'

const ICON_TYPES = new Set<string>(Object.values(ICON_MIME))

/**
 * 自分の表示名とアイコンのモーダル。名前は「保存」で PUT /api/profile、画像は「画像を選ぶ」→ 加工（IconCropper）→ PUT /api/profile/icon。
 * onClose には最後に保存した値を渡す（無ければ undefined）。呼び出し側はそれを出し、ポーリングが追いついたら本物に戻る
 */
export function ProfileEditor({ profile, onClose }: { profile: Profile; onClose: (saved?: Profile) => void }) {
  const [name, setName] = useState(profile.name ?? '')
  const [current, setCurrent] = useState<Profile>(profile)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [cropping, setCropping] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const savedRef = useRef<Profile | undefined>(undefined)

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>('input.name-input')?.focus()
  }, [])

  const close = () => onClose(savedRef.current)
  const remember = (p: Profile) => {
    savedRef.current = p
    setCurrent(p)
  }

  const save = async () => {
    const { error: reason } = mergeProfile(current, { name })
    if (reason) return setError(reason)
    setBusy(true)
    setError('')
    try {
      const res = await api.setProfile({ name })
      remember(res.profile)
      onClose(res.profile)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const pickIcon = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.type && !ICON_TYPES.has(file.type)) return setError('画像ファイル（PNG / JPEG / GIF / WebP）を選んでください')
    if (file.size > ICON_SOURCE_MAX_BYTES) return setError(`画像は ${ICON_SOURCE_MAX_BYTES / 1024 / 1024}MB までです`)
    setError('')
    setCropping(file)
  }
  const putIcon = async (blob: Blob) => {
    setCropping(null)
    setBusy(true)
    setError('')
    try {
      remember((await api.setProfileIcon(blob)).profile)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const clearIcon = async () => {
    setBusy(true)
    setError('')
    try {
      remember((await api.clearProfileIcon()).profile)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 日本語入力の確定 Enter で保存しない
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      void save()
    }
  }

  // 加工中は IconCropper が前面（自分のモーダルは後ろに残す）
  return (
    <>
      <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !cropping && close()}>
        <div
          className="modal profile"
          role="dialog"
          aria-modal="true"
          aria-label="表示名とアイコン"
          tabIndex={-1}
          ref={dialogRef}
          onKeyDown={(e) => e.key === 'Escape' && !cropping && close()}
        >
          <div className="title">表示名とアイコン</div>
          <div className="row">
            <span className="avatar me big">{current.icon ? <img src={current.icon} alt="" /> : '私'}</span>
            <div className="icon-actions">
              <input ref={fileRef} className="file" type="file" accept={ICON_ACCEPT} onChange={pickIcon} disabled={busy} aria-label="アイコン画像" />
              <button type="button" className="linkish" onClick={() => fileRef.current?.click()} disabled={busy}>
                {current.icon ? '画像を変える' : '画像を選ぶ'}
              </button>
              {current.icon && (
                <button type="button" className="linkish" onClick={() => void clearIcon()} disabled={busy}>
                  画像を消す
                </button>
              )}
            </div>
          </div>
          <label className="field">
            表示名
            <input
              className="name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="あなた"
              maxLength={META_NAME_MAX}
              disabled={busy}
            />
          </label>
          <div className="hint">チャットの自分側のバブルの名前とアバターになります。空にすると「あなた」「私」に戻ります</div>
          {error && <div className="err">{error}</div>}
          <div className="actions">
            <button type="button" className="linkish" onClick={close} disabled={busy}>
              閉じる
            </button>
            <button type="button" className="primary" onClick={() => void save()} disabled={busy || name.trim() === (current.name ?? '')}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
      {cropping && <IconCropper key={`${cropping.name}:${cropping.lastModified}`} file={cropping} onDone={(blob) => void putIcon(blob)} onCancel={() => setCropping(null)} />}
    </>
  )
}
