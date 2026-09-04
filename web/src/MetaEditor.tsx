import { useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { ICON_ACCEPT, ICON_MIME, ICON_SOURCE_MAX_BYTES } from '../../shared/icon.ts'
import { META_NAME_MAX, normalizeMeta } from '../../shared/meta.ts'
import type { SessionMeta } from '../../shared/types.ts'
import { api } from './api'
import { IconCropper } from './IconCropper'

const ICON_TYPES = new Set<string>(Object.values(ICON_MIME))

/**
 * チャット見出しの「表示名とアイコン画像」。見るだけのときは画像と名前、「変更」で名前の入力欄に変わる。
 * 画像は「画像を選ぶ」で手元のファイルを選ぶと加工のモーダル（IconCropper）が開き、正方形・角丸の PNG にしてから送る
 * （PUT /api/sessions/<id>/icon）。元のファイルは送らない。「画像を消す」は DELETE。
 * 名前の保存はサーバ（PUT /api/sessions/<id>/meta）。保存直後は返ってきた値をそのまま出し、
 * 3秒ポーリングが追いついたら props の meta / icon に戻る。
 * 呼び出し側は key={id} を付けること（別のセッションに移ったら編集状態ごと作り直す）。
 */
export function MetaEditor({ id, meta, icon }: { id: string; meta: SessionMeta | undefined; icon: string | undefined }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<SessionMeta | null>(null)
  // 画像を置いた・消した直後の URL。null は「消した」、undefined はまだ触っていない（props を見る）
  const [savedIcon, setSavedIcon] = useState<string | null | undefined>(undefined)
  // 加工中のファイル。モーダルを出している間だけ
  const [cropping, setCropping] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pickRef = useRef<HTMLButtonElement>(null)

  const current = saved ?? meta ?? {}
  const currentIcon = savedIcon === undefined ? icon : (savedIcon ?? undefined)

  const start = () => {
    setName(current.name ?? '')
    setError('')
    setEditing(true)
  }
  const cancel = () => {
    setEditing(false)
    setError('')
  }
  const save = async () => {
    const { meta: next, error: reason } = normalizeMeta({ name })
    if (reason) return setError(reason)
    setBusy(true)
    setError('')
    try {
      const res = await api.setMeta(id, next)
      setSaved(res.meta)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const clearName = async () => {
    setName('')
    setBusy(true)
    setError('')
    try {
      // PUT は重ねる意味なので、消すときは明示的に空を送る（アーカイブなど他のキーは触らない）
      const res = await api.setMeta(id, { name: '' })
      setSaved(res.meta)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const pickIcon = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 同じファイルをもう一度選んでも change が飛ぶように
    if (!file) return
    // 選んだ瞬間に弾けるものは弾く（種類と大きさ）。送るのは加工後の PNG で、中身の検査はサーバがする
    if (file.type && !ICON_TYPES.has(file.type)) return setError('画像ファイル（PNG / JPEG / GIF / WebP）を選んでください')
    if (file.size > ICON_SOURCE_MAX_BYTES) return setError(`画像は ${ICON_SOURCE_MAX_BYTES / 1024 / 1024}MB までです`)
    setError('')
    setCropping(file)
  }
  const closeCropper = () => {
    setCropping(null)
    pickRef.current?.focus()
  }
  const putIcon = async (blob: Blob) => {
    closeCropper()
    setBusy(true)
    setError('')
    try {
      const res = await api.setIcon(id, blob)
      setSavedIcon(res.icon)
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
      await api.clearIcon(id)
      setSavedIcon(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') cancel()
    // 日本語入力の確定 Enter で保存しない
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      void save()
    }
  }

  // 画像の操作は見るだけのときも編集中も同じ
  const iconControls = (
    <>
      <input ref={fileRef} className="file" type="file" accept={ICON_ACCEPT} onChange={pickIcon} disabled={busy} aria-label="アイコン画像" />
      <button ref={pickRef} type="button" className="linkish" onClick={() => fileRef.current?.click()} disabled={busy}>
        {currentIcon ? '画像を変える' : '画像を選ぶ'}
      </button>
      {cropping && <IconCropper key={`${cropping.name}:${cropping.lastModified}`} file={cropping} onDone={(blob) => void putIcon(blob)} onCancel={closeCropper} />}
      {currentIcon && (
        <button type="button" className="linkish" onClick={() => void clearIcon()} disabled={busy}>
          画像を消す
        </button>
      )}
    </>
  )

  if (!editing) {
    return (
      <div className="meta wide session-name">
        {currentIcon && <img className="icon" src={currentIcon} alt="" />}
        {current.name ? <b>{current.name}</b> : <span className="none">表示名なし</span>}
        <button type="button" className="linkish" onClick={start} disabled={busy}>
          {current.name ? '変更' : '名前を付ける'}
        </button>
        {iconControls}
        {error && <span className="err">{error}</span>}
      </div>
    )
  }
  return (
    <form
      className="meta wide session-name editing"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      {currentIcon && <img className="icon" src={currentIcon} alt="" />}
      <input
        className="name-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="表示名"
        aria-label="表示名"
        maxLength={META_NAME_MAX}
        autoFocus
        disabled={busy}
      />
      <button type="submit" disabled={busy}>
        {busy ? '保存中…' : '保存'}
      </button>
      <button type="button" className="linkish" onClick={cancel} disabled={busy}>
        やめる
      </button>
      {current.name && (
        <button type="button" className="linkish" onClick={() => void clearName()} disabled={busy}>
          名前を消す
        </button>
      )}
      {iconControls}
      {error && <span className="err">{error}</span>}
    </form>
  )
}
