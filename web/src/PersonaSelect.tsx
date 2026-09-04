import { PERSONAS } from '../../shared/persona.ts'
import type { PersonaId } from './api'

/** ヘッダの性格の select。一言（digest）が有効なときだけ出す。値はサーバの設定（PUT /api/settings） */
export function PersonaSelect({ value, busy, onChange }: { value: PersonaId; busy: boolean; onChange: (next: PersonaId) => void }) {
  return (
    <select
      className="persona"
      value={value}
      disabled={busy}
      onChange={(e) => onChange(e.target.value as PersonaId)}
      aria-label="一言コメントの性格"
      title="一言コメントの性格（口調）。変えると以後の行から効く"
    >
      {PERSONAS.map((p) => (
        <option key={p.id} value={p.id}>{p.label}</option>
      ))}
    </select>
  )
}
