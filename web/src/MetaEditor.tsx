import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { META_NAME_MAX, normalizeMeta } from '../../shared/meta.ts'
import type { SessionMeta } from '../../shared/types.ts'
import { api } from './api'

/**
 * チャット見出しの「表示名とアイコン」。見るだけのときは絵文字と名前、「変更」で入力欄に変わる。
 * 保存はサーバ（PUT /api/sessions/<id>/meta）。保存直後は返ってきた値をそのまま出し、
 * 3秒ポーリングが追いついたら props の meta に戻る。
 * 呼び出し側は key={id} を付けること（別のセッションに移ったら編集状態ごと作り直す）。
 */
export function MetaEditor({ id, meta }: { id: string; meta: SessionMeta | undefined }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<SessionMeta | null>(null)

  const current = saved ?? meta ?? {}
  const hasMeta = Boolean(current.name || current.icon)

  const start = () => {
    setName(current.name ?? '')
    setIcon(current.icon ?? '')
    setError('')
    setEditing(true)
  }
  const cancel = () => {
    setEditing(false)
    setError('')
  }
  const save = async () => {
    const { meta: next, error: reason } = normalizeMeta({ name, icon })
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
  const clear = async () => {
    setName('')
    setIcon('')
    setBusy(true)
    setError('')
    try {
      // PUT は重ねる意味なので、消すときは明示的に空を送る（アーカイブなど他のキーは触らない）
      const res = await api.setMeta(id, { name: '', icon: '' })
      setSaved(res.meta)
      setEditing(false)
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

  if (!editing) {
    return (
      <div className="meta wide session-name">
        {current.icon && <span className="icon">{current.icon}</span>}
        {current.name ? <b>{current.name}</b> : <span className="none">表示名なし</span>}
        <button type="button" className="linkish" onClick={start}>
          {hasMeta ? '変更' : '名前を付ける'}
        </button>
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
      <input
        className="icon-input"
        value={icon}
        onChange={(e) => setIcon(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="絵文字"
        aria-label="アイコン（絵文字1つ）"
        disabled={busy}
      />
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
      {hasMeta && (
        <button type="button" className="linkish" onClick={() => void clear()} disabled={busy}>
          消す
        </button>
      )}
      {error && <span className="err">{error}</span>}
    </form>
  )
}
