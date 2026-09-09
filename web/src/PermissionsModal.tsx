import { useEffect, useRef, useState } from 'react'
import { KIND_LABEL, modeLabel, modeSkipsRules, PERMISSION_KINDS, SOURCE_HINT, SOURCE_LABEL } from '../../shared/permissions.ts'
import { api, type SessionPermissionsResponse } from './api'

/**
 * そのセッションで何が許可されているかの一覧（#162）。開いたときに 1 回だけ取る（3 秒のポーリングには乗せない）。
 * 並びは評価の順そのもの（deny → ask → allow）で、deny はどの出どころのものでも allow に勝つ。
 * 読むだけで、ここからは足せない・消せない（足すのはチャットの [常に許可]）
 */
export function PermissionsModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<SessionPermissionsResponse | null>(null)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dialogRef.current?.focus()
    let alive = true
    api
      .permissions(id)
      .then((d) => alive && setData(d))
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [id])

  const rules = data?.rules ?? []
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal permissions"
        role="dialog"
        aria-modal="true"
        aria-label="このセッションで許可されているもの"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="title">このセッションで許可されているもの</div>
        {error && <div className="err">取得失敗: {error}</div>}
        {!data && !error && <div className="hint">読み込み中…</div>}
        {data && (
          <>
            <div className="mode">
              許可モード:{' '}
              <b className={modeSkipsRules(data.mode) ? 'loud' : ''}>{data.mode ? `${data.mode}（${modeLabel(data.mode)}）` : '不明（記録が古い）'}</b>
              {modeSkipsRules(data.mode) && <div className="warn">このモードでは下のルールに関係なく実行されます。</div>}
            </div>
            {data.agent !== 'claude' ? (
              <div className="hint">
                許可の一覧は Claude Code のセッションだけです。Codex の許可は <code>~/.codex/config.toml</code> の{' '}
                <code>approval_policy</code> / <code>trust_level</code> にあります。
              </div>
            ) : (
              <>
                {rules.length === 0 && <div className="hint">個別のルールはありません（毎回聞かれます）。</div>}
                {PERMISSION_KINDS.map((kind) => {
                  const group = rules.filter((r) => r.kind === kind)
                  if (group.length === 0) return null
                  return (
                    <div className={`group ${kind}`} key={kind}>
                      <div className="head">
                        {KIND_LABEL[kind]}
                        <span className="n">{group.length}</span>
                      </div>
                      <ul>
                        {group.map((r) => (
                          <li key={`${r.source}:${r.rule}`}>
                            <code>{r.rule}</code>
                            <span className="src" title={SOURCE_HINT[r.source]}>{SOURCE_LABEL[r.source]}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
                <div className="files">
                  <div className="head">読んだ先</div>
                  <ul>
                    {data.sources.map((s) => (
                      <li key={s.kind} className={s.missing ? 'missing' : s.broken ? 'broken' : ''}>
                        <span className="src" title={SOURCE_HINT[s.kind]}>{SOURCE_LABEL[s.kind]}</span>
                        <code>{s.path}</code>
                        {s.missing && <span className="note">無し</span>}
                        {s.broken && <span className="note">読めない</span>}
                        {s.default_mode && <span className="note">defaultMode: {s.default_mode}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="hint">
                  評価は上から順（拒否 → 毎回聞く → 許可）で、最初に当たったもので決まります。拒否はどの出どころのものでも許可に勝ちます。
                  ここからは変えられません（足すのはチャットの [常に許可]、消すのは設定ファイル）。
                </div>
              </>
            )}
          </>
        )}
        <div className="actions">
          <button type="button" className="primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
