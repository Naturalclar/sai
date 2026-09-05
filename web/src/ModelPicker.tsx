import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { META_MODEL_MAX, normalizeMeta } from '../../shared/meta.ts'
import type { Agent } from '../../shared/types.ts'
import { api } from './api'

/** Claude の `--model` が受ける別名。Codex には別名が無い */
const CLAUDE_ALIASES = ['fable', 'opus', 'sonnet', 'haiku']
const CUSTOM = '__custom__'

interface Props {
  id: string
  agent: Agent
  /** 一番新しいターンを回したモデル（SessionSummary.model）。無ければ空で、チップは出さない */
  model: string
  /** 出てきたモデル全部（出てきた順）。2 つ以上なら「+N」を付ける */
  models: string[]
  /** SAI からの返信で使うモデル（SessionMeta.model）。無ければ CLI の既定 */
  replyModel: string | undefined
  /** 返信できるセッションか。できないなら選択肢は出さない（見るだけ） */
  canReply: boolean
}

/**
 * チャット見出しの「モデル」。実際に使われたモデル（記録から）と、SAI からの返信で使うモデル（設定）を分けて出す。
 * 設定は PUT /api/sessions/<id>/meta の model。候補はそのセッションで出てきたモデルと Claude の別名、あとは自由入力。
 * Claude は `--resume` に `--model` を付けるとセッションのモデル設定そのものが変わる（端末で再開してもそのモデル）ので、
 * 選択肢の title にそう書く。呼び出し側は key={id} を付けること
 */
export function ModelPicker({ id, agent, model, models, replyModel, canReply }: Props) {
  // 保存直後の値（ポーリングが追いつくまで）。null ならまだ触っていない（props を見る）
  const [saved, setSaved] = useState<string | null>(null)
  const [custom, setCustom] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const current = saved !== null ? saved : (replyModel ?? '')
  const aliases = agent === 'claude' ? CLAUDE_ALIASES : []
  const choices = [...new Set([...models, ...aliases, ...(current ? [current] : [])])]

  const save = async (value: string) => {
    const { meta, error: reason } = normalizeMeta({ model: value })
    if (reason) return setError(reason)
    setBusy(true)
    setError('')
    try {
      // PUT は重ねる意味。空を送れば「消す」= CLI の既定に戻す
      const res = await api.setMeta(id, { model: meta.model ?? '' })
      setSaved(res.meta.model ?? '')
      setCustom(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onSelect = (value: string) => {
    if (value === CUSTOM) {
      setDraft(current)
      setCustom(true)
      return
    }
    void save(value)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') setCustom(false)
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      void save(draft)
    }
  }

  if (!model && !canReply) return null
  return (
    <span className="model-pick">
      {model && (
        <code title={models.length > 1 ? `使ったモデル（順に）: ${models.join(' → ')}` : '一番新しいターンを回したモデル'}>
          {model}
          {models.length > 1 && <span className="more">+{models.length - 1}</span>}
        </code>
      )}
      {canReply &&
        (custom ? (
          <span className="custom">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="モデル名（空で既定）"
              aria-label="返信で使うモデル"
              maxLength={META_MODEL_MAX}
              autoFocus
              disabled={busy}
            />
            <button type="button" className="linkish" onClick={() => void save(draft)} disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </button>
            <button type="button" className="linkish" onClick={() => setCustom(false)} disabled={busy}>
              やめる
            </button>
          </span>
        ) : (
          <label
            className="reply-model"
            title={
              'SAI からの返信で使うモデル。無ければ CLI の既定。' +
              (agent === 'claude' ? ' Claude は --resume に --model を付けるとセッションのモデル設定そのものが変わる（端末で再開してもそのモデル）' : '')
            }
          >
            返信:
            <select value={current} onChange={(e) => onSelect(e.target.value)} disabled={busy} aria-label="返信で使うモデル">
              <option value="">既定</option>
              {choices.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              <option value={CUSTOM}>その他…</option>
            </select>
          </label>
        ))}
      {error && <span className="err">{error}</span>}
    </span>
  )
}
