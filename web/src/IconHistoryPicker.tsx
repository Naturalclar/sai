import { useEffect, useRef, useState } from 'react'
import type { IconHistoryItem } from '../../shared/types.ts'
import { api, type IconTarget } from './api'
import { nextRemoval } from './iconHistory'
import { TrashMark } from './TrashMark'

interface Props {
  target: IconTarget
  /** 選んだ画像を付ける（呼び出し側が PUT する）。成功したら閉じるのも呼び出し側 */
  onPick: (key: string) => void
  onClose: () => void
  /** 付けている最中（呼び出し側の busy）。その間は押せない */
  busy: boolean
  /**
   * 付けるのに失敗した理由（呼び出し側の error）。**このモーダルの中に出す**（後ろの編集欄に書いても
   * 背景に隠れて読めない。別のタブで消された画像を押したときに「押しても何も起きない」に見えた）
   */
  error?: string
}

/**
 * 今まで使ったアイコン画像から選ぶモーダル（#465）。開いたときに 1 回だけ取る（ポーリングには乗せない）。
 * 押したらその画像をそのまま付ける（加工済みなので IconCropper は通さない）。いまのアイコンと同じ画像には印を付ける。
 * それぞれの隅のゴミ箱で履歴から消せる（2 回押しで消す。いま使っているアイコンは消えない）
 */
export function IconHistoryPicker({ target, onPick, onClose, busy, error: pickError }: Props) {
  const [items, setItems] = useState<IconHistoryItem[] | null>(null)
  const [current, setCurrent] = useState<string | undefined>(undefined)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  // 対象は文字列 1 つにして effect の依存にする（オブジェクトは描画のたびに新しくなる）
  const targetKey = target.kind === 'profile' ? 'profile' : `session:${target.id}`

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => {
    let alive = true
    const which: IconTarget = targetKey === 'profile' ? { kind: 'profile' } : { kind: 'session', id: targetKey.slice('session:'.length) }
    api
      .iconHistory(which)
      .then((res) => {
        if (!alive) return
        setItems(res.items)
        setCurrent(res.current)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [targetKey])

  const remove = async (key: string) => {
    const step = nextRemoval(confirming, key)
    setConfirming(step.confirming)
    if (!step.remove) return
    setError('')
    try {
      const res = await api.removeIconHistory(key)
      setItems(res.items)
      // 押したボタンは消えた項目ごと無くなり、フォーカスが body に落ちる。そのままだと次の Esc が
      // このモーダルに届かず、App の「Esc でフィードへ」まで動いてしまうので、モーダルに戻しておく
      dialogRef.current?.focus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal icon-history"
        role="dialog"
        aria-modal="true"
        aria-label="今まで使った画像"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          // 後ろのモーダル（自分のアイコン）まで閉じない
          e.stopPropagation()
          onClose()
        }}
      >
        <div className="title">今まで使った画像</div>
        {items === null && !error && <div className="hint">読み込み中…</div>}
        {items !== null && items.length === 0 && <div className="hint">まだありません。画像を選んで付けると、ここに残ります</div>}
        {items !== null && items.length > 0 && (
          <ul className="grid">
            {items.map((item) => (
              <li key={item.key} className={item.key === current ? 'current' : undefined}>
                <button
                  type="button"
                  className="pick"
                  onClick={() => onPick(item.key)}
                  disabled={busy}
                  aria-pressed={item.key === current}
                  title={item.key === current ? 'いまのアイコン' : 'この画像にする'}
                >
                  <img src={item.url} alt="" />
                </button>
                <button
                  type="button"
                  className={`remove${confirming === item.key ? ' confirming' : ''}`}
                  onClick={() => void remove(item.key)}
                  disabled={busy}
                  aria-label={confirming === item.key ? 'もう一度押すと履歴から消します' : '履歴から消す'}
                  title={confirming === item.key ? 'もう一度押すと履歴から消します' : '履歴から消す'}
                >
                  {confirming === item.key ? '消す' : <TrashMark />}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="hint">押すとその画像にします。消しても、いまその画像を使っているアイコンはそのまま残ります</div>
        {(pickError || error) && <div className="err">{pickError || error}</div>}
        <div className="actions">
          <button type="button" className="linkish" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
