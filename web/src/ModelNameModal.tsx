import { useEffect, useRef, useState } from 'react'
import { META_MODEL_MAX, normalizeMeta } from '../../shared/meta.ts'

interface Props {
  /** 開いたときの値。空なら CLI の既定 */
  value: string
  /** 決まった値を返す。空文字なら「既定に戻す」 */
  onSave: (model: string) => void
  onClose: () => void
}

/**
 * 候補に無いモデル名を手で入れるモーダル（入力欄の「その他…」から開く）。
 * 入力欄の中に input を生やすと狭いので、DiffModal / ProfileEditor と同じ形の小さなモーダルにする。
 * 検査はサーバと同じ `normalizeMeta()` で、通らなければ理由を出して閉じない
 */
export function ModelNameModal({ value, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const save = () => {
    const { meta, error: reason } = normalizeMeta({ model: draft })
    if (reason) return setError(reason)
    onSave(meta.model ?? '')
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal model-name"
        role="dialog"
        aria-modal="true"
        aria-label="返信で使うモデル"
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div className="title">返信で使うモデル</div>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setError('')
          }}
          placeholder="モデル名（空で既定）"
          aria-label="モデル名"
          maxLength={META_MODEL_MAX}
        />
        <div className="note">候補に無い名前を直接入れる。空にすると CLI の既定に戻る</div>
        {error && <div className="err">{error}</div>}
        <div className="actions">
          <button type="submit">決定</button>
          <button type="button" className="linkish" onClick={onClose}>やめる</button>
        </div>
      </form>
    </div>
  )
}
