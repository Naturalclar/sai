import { SHORTCUT_GROUPS, isMacPlatform, keyLabel } from './shortcuts'

interface Props {
  onClose: () => void
}

/**
 * キーボードショートカットの一覧（#910）。`?` かヘッダの「?」で開き、`Esc`・外側・もう一度 `?` で閉じる。
 * 中身は `shortcuts.ts` の `SHORTCUT_GROUPS` だけから描く（ここにキーを書かない）。Mac 以外では `⌘` を `Ctrl+` で見せる
 */
export function ShortcutHelp({ onClose }: Props) {
  const mac = isMacPlatform(typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { userAgentData?: { platform?: string } }))
  return (
    <div className="modal-backdrop shortcut-help-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcut-help" role="dialog" aria-modal="true" aria-label="キーボードショートカット">
        <div className="title">キーボードショートカット</div>
        <div className="shortcut-groups">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={`group:${group.title}`} className="shortcut-group">
              <h3>
                {group.title}
                {group.note && <small>{group.note}</small>}
              </h3>
              <dl>
                {group.items.map((item) => (
                  <div key={`item:${item.keys.join(' ')}:${item.what}`} className="shortcut-row">
                    <dt>
                      {item.keys.map((k) => (
                        <kbd key={`key:${k}`}>{keyLabel(k, mac)}</kbd>
                      ))}
                    </dt>
                    <dd>{item.what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="actions">
          <button type="button" className="linkish" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  )
}
