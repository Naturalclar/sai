import { useState } from 'react'
import { PERSONAS, personaOf } from '../../shared/persona.ts'
import type { PersonaId } from './api'
import { api } from './api'

/** 「このセッションでは作らない」を表す select の値。`PersonaId` とは別物（口調ではないので混ぜない。#263） */
const OFF = 'off'

interface Props {
  id: string
  /** このセッションの性格（メタ）。無ければ既定に従う */
  value: PersonaId | undefined
  /** このセッションでは一言を作らない（メタの digest_off）。#263 */
  off: boolean
  /** 全体の既定（ヘッダの select）。「既定（…）」の表示に使う */
  defaultPersona: PersonaId
}

/**
 * チャット見出しの、このセッションの一言の設定。値はセッションのメタ（PUT /api/sessions/<id>/meta）。
 * 「既定」を選ぶと空を送って消し、全体の設定に従う。**「作らない」は `digest_off`** で、以後そのセッションでは
 * 一言を作らず、切る前に作ってあるぶんも画面に出さない（記録は消さない）。
 * 変えると以後の行から効く（過去の一言は作り直さない）。
 * 保存直後は返ってきた値を出し、ポーリングが追いついたら props に戻る。呼び出し側は key={id} を付けること
 */
export function SessionPersonaSelect({ id, value, off, defaultPersona }: Props) {
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = saved ?? (off ? OFF : (value ?? ''))

  const change = async (next: string) => {
    setBusy(true)
    setError('')
    try {
      // 「作らない」は digest_off を立てる。それ以外は digest_off を外して persona を送る
      // （空文字は「消す」= 既定に従う。型は PersonaId だがサーバの mergeMeta は空を受ける）
      const res =
        next === OFF
          ? await api.setMeta(id, { digest_off: true })
          : await api.setMeta(id, { persona: next as PersonaId, digest_off: null })
      setSaved(res.meta.digest_off ? OFF : (res.meta.persona ?? ''))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="meta session-persona">
      <select
        className="persona"
        value={current}
        disabled={busy}
        onChange={(e) => void change(e.target.value)}
        aria-label="このセッションの一言コメント"
        title="このセッションの一言コメント。「既定」なら全体の設定（ヘッダ）に従う。「作らない」にすると以後は作らず、すでにあるぶんも出さない。変えると以後の行から効く"
      >
        <option value="">既定（{personaOf(defaultPersona).label}）</option>
        {PERSONAS.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
        <option value={OFF}>一言を作らない</option>
      </select>
      {error && <span className="err">{error}</span>}
    </span>
  )
}
