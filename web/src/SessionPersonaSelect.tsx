import { useState } from 'react'
import { PERSONAS, personaOf } from '../../shared/persona.ts'
import type { PersonaId } from './api'
import { api } from './api'

interface Props {
  id: string
  /** このセッションの性格（メタ）。無ければ既定に従う */
  value: PersonaId | undefined
  /** 全体の既定（ヘッダの select）。「既定（…）」の表示に使う */
  defaultPersona: PersonaId
}

/**
 * チャット見出しの、このセッションの一言の性格。値はセッションのメタ（PUT /api/sessions/<id>/meta の persona）。
 * 「既定」を選ぶと空を送って消し、全体の設定に従う。変えると以後の行から効く（過去の一言は作り直さない）。
 * 保存直後は返ってきた値を出し、ポーリングが追いついたら props に戻る。呼び出し側は key={id} を付けること
 */
export function SessionPersonaSelect({ id, value, defaultPersona }: Props) {
  const [saved, setSaved] = useState<PersonaId | '' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = saved ?? value ?? ''

  const change = async (next: string) => {
    setBusy(true)
    setError('')
    try {
      // 空文字は「消す」（既定に従う）。型は PersonaId だがサーバの mergeMeta は空を受ける
      const res = await api.setMeta(id, { persona: next as PersonaId })
      setSaved(res.meta.persona ?? '')
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
        aria-label="このセッションの一言コメントの性格"
        title="このセッションの一言コメントの性格。「既定」なら全体の設定（ヘッダ）に従う。変えると以後の行から効く"
      >
        <option value="">既定（{personaOf(defaultPersona).label}）</option>
        {PERSONAS.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      {error && <span className="err">{error}</span>}
    </span>
  )
}
