import { useEffect, useRef, useState } from 'react'
import type { Agent } from '../../shared/types.ts'
import { MODEL_CUSTOM_LABEL, MODEL_DEFAULT_LABEL, modelButtonLabel, modelChoices } from './modelChoices'
import { api } from './api'
import { ModelNameModal } from './ModelNameModal'

export interface ReplyModelProps {
  /** 返信先のエンティティID。ここに保存する */
  id: string
  agent: Agent
  /** そのセッションで出てきたモデル（候補にする） */
  models: readonly string[]
  /** いま設定されている返信のモデル。無ければ CLI の既定 */
  value: string | undefined
}

/**
 * 入力欄の、送信ボタンの左に出すモデル。押すとメニューが開き、選ぶとそのセッションの返信モデルが変わる
 * （`PUT /api/sessions/<id>/meta` の `model`。次の返信から効く）。
 * 閉じているときは短い名前（`claude-opus-5` → `opus`）で、メニューには正式名を出す（別名と見分けが付かなくなるため）。
 * 候補に無い名前は `Custom model…` からモーダルで入れる。Esc と外側クリックで閉じるのは UserMenu と同じ。
 * **選択肢の名前は英語**（#282。隣の許可モードの #271 と揃える）で、何が起きるかは日本語の補足で出す。
 * 呼び出し側は key={id} を付けること（別のセッションに移ったら開閉ごと作り直す）
 */
export function ReplyModelPicker({ id, agent, models, value }: ReplyModelProps) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState(false)
  // 保存直後の値（ポーリングが追いつくまで）。null ならまだ触っていない（props を見る）
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const current = saved !== null ? saved : (value ?? '')
  const choices = modelChoices(agent, models, current)

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

  const save = async (model: string) => {
    setOpen(false)
    setCustom(false)
    setBusy(true)
    setError('')
    try {
      // PUT は重ねる意味。空を送れば「消す」= CLI の既定に戻す
      const res = await api.setMeta(id, { model })
      setSaved(res.meta.model ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      buttonRef.current?.focus()
    }
  }

  return (
    <div className="model-pick" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`返信で使うモデル${current ? `: ${current}` : '（いまは CLI の既定）'}。押すと変えられる。次の返信から効く`}
      >
        {busy ? '…' : modelButtonLabel(current)}
      </button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" className={current ? '' : 'picked'} onClick={() => void save('')}>
            {MODEL_DEFAULT_LABEL}
            <span className="why">CLI に任せる</span>
          </button>
          {choices.map((m) => (
            <button type="button" role="menuitem" key={m} className={m === current ? 'picked' : ''} onClick={() => void save(m)}>
              {m}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              setCustom(true)
            }}
          >
            {MODEL_CUSTOM_LABEL}
          </button>
        </div>
      )}
      {custom && <ModelNameModal value={current} onSave={(m) => void save(m)} onClose={() => setCustom(false)} />}
      {error && <span className="err">{error}</span>}
    </div>
  )
}
