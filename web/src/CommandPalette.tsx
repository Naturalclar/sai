import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { filterPalette, moveIndex, paletteHash, paletteItems } from '../../shared/palette.ts'
import type { SessionSummary } from './api'

interface Props {
  /** 候補の元。⌘K を開いたときに取り直した「絞り込み無し」の一覧（まだなら画面が持っている分） */
  sessions: readonly SessionSummary[]
  /** 取り直しがまだ終わっていない。「絞り込み中の分だけ」と断る */
  loading: boolean
  onClose: () => void
}

/**
 * ⌘K の移動用モーダル（#197）。フィードとセッションを名前で絞って、選んだらその画面へ飛ぶ。
 * **移動だけ**でコマンドは実行しない。↑↓ で選び、Enter で決定、Esc で閉じる。
 * 候補は本物のリンク（`<a href="#/...">`）なので、⌘クリックや「リンクをコピー」も普通に効く。
 * Enter は選んでいるリンクを click() する（hash を直接書き換えない）
 */
export function CommandPalette({ sessions, loading, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const items = useMemo(() => filterPalette(paletteItems(sessions), query), [sessions, query])
  // 候補が減って範囲から出ることがある（打つたびに絞られる）
  const at = Math.min(index, Math.max(items.length - 1, 0))

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /** 選択を動かして、見えるところまでスクロールする（長い一覧で ↓ を押し続けたとき） */
  const move = (direction: 'prev' | 'next') => {
    const to = moveIndex(at, items.length, direction)
    setIndex(to)
    listRef.current?.querySelectorAll('li')[to]?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 'next' : 'prev')
      return
    }
    // IME の変換中の Enter で決めない（候補の確定）
    if (e.key === 'Enter' && !(e.nativeEvent.isComposing || e.keyCode === 229)) {
      e.preventDefault()
      listRef.current?.querySelectorAll('li')[at]?.querySelector('a')?.click()
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="セッションを検索" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          placeholder="フィードかセッションを検索（↑↓ で選んで Enter、Esc で閉じる）"
          aria-label="検索"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
        />
        <ul className="mention palette-list" id="palette-list" role="listbox" aria-label="候補" ref={listRef}>
          {items.length === 0 && <li className="none">該当するものがありません</li>}
          {items.map((item, i) => (
            <li
              key={item.kind === 'feed' ? 'feed' : item.id}
              role="option"
              aria-selected={i === at}
              className={i === at ? 'active' : ''}
              onMouseEnter={() => setIndex(i)}
            >
              <a href={paletteHash(item)} title={item.kind === 'session' ? item.id : 'すべてのセッションを時系列に'} onClick={onClose} tabIndex={-1}>
                {item.kind === 'session' && item.icon && <img className="icon" src={item.icon} alt="" width={16} height={16} />}
                <b>{item.label}</b>
                <span className="title">{item.hint}</span>
                {item.kind === 'session' && item.archived && <span className="tag archived">アーカイブ</span>}
              </a>
            </li>
          ))}
        </ul>
        {loading && <div className="hint">絞り込み中の一覧から出しています（全部を取りに行っています）</div>}
      </div>
    </div>
  )
}
