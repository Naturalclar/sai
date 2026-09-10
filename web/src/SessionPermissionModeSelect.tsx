import { useState } from 'react'
import { MODE_LABEL, modeSkipsRules, REPLY_MODES } from '../../shared/permissions.ts'
import type { ReplyPermissionMode } from '../../shared/types.ts'
import { api } from './api'

interface Props {
  id: string
  /** このセッションの許可モード（メタ）。無ければ CLI の既定 */
  value: ReplyPermissionMode | undefined
  /** 端末（tmux）で開いているか。開いていると打ち込む経路になり、この設定は効かない */
  terminal: boolean
}

/**
 * チャット見出しの、SAI から返信するときの許可モード。値はセッションのメタ（PUT /api/sessions/<id>/meta の permission_mode）。
 * 「既定」を選ぶと空を送って消す。並ぶのは shared/permissions.ts の REPLY_MODES で、サーバの検査と同じ一覧。
 * **素通し（bypassPermissions）を選んでいる間は印を出す**（#253）。許可を聞かなくなるので、
 * 選んだまま忘れているのが一番まずい。判定は modeSkipsRules() で、見出しのタグやモーダルと同じもの。
 * 端末に打ち込む経路ではフラグを渡す先が無いので効かない（そのときは薄く出して、その旨を title に出す）。
 * 保存直後は返ってきた値を出し、ポーリングが追いついたら props に戻る。呼び出し側は key={id} を付けること
 */
export function SessionPermissionModeSelect({ id, value, terminal }: Props) {
  const [saved, setSaved] = useState<ReplyPermissionMode | '' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = saved ?? value ?? ''

  const change = async (next: string) => {
    setBusy(true)
    setError('')
    try {
      // 空文字は「消す」（CLI の既定に従う）
      const res = await api.setMeta(id, { permission_mode: next as ReplyPermissionMode })
      setSaved(res.meta.permission_mode ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className={`meta session-permission-mode${terminal ? ' inactive' : ''}`}>
      <select
        value={current}
        disabled={busy}
        onChange={(e) => void change(e.target.value)}
        aria-label="SAI から返信するときの許可モード"
        title={
          terminal
            ? 'SAI から返信するときの許可モード。いまは端末（tmux）で開いているので返信は端末に打ち込まれ、この設定は効かない（端末側は Shift+Tab で切り替える）'
            : 'SAI から返信するときの許可モード。そのターンだけに効き、セッションには残らない。端末に打ち込む返信には効かない'
        }
      >
        <option value="">許可は既定（聞く）</option>
        {REPLY_MODES.map((m) => (
          <option key={m} value={m}>{MODE_LABEL[m]}</option>
        ))}
      </select>
      {modeSkipsRules(current) && (
        <b className="loud" title="このセッションへの SAI からの返信は、許可を聞かずに何でも実行します（質問は今までどおり出ます）">
          素通し
        </b>
      )}
      {error && <span className="err">{error}</span>}
    </span>
  )
}
