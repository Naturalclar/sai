import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { filterPalette, moveIndex, paletteHash, paletteItems } from '../../shared/palette.ts'
import { hm } from './format'
import { sessionHash } from './hooks'
import { Highlight } from './Highlight'
import { MIN_QUERY_LENGTH, useSearch } from './useSearch'
import type { SessionSummary } from './api'

interface Props {
  /** 候補の元。⌘K を開いたときに取り直した「絞り込み無し」の一覧（まだなら画面が持っている分） */
  sessions: readonly SessionSummary[]
  /** 取り直しがまだ終わっていない。「絞り込み中の分だけ」と断る */
  loading: boolean
  onClose: () => void
}

/**
 * ⌘K の移動用モーダル（#197）。**移動だけ**でコマンドは実行しない。
 * ↑↓ で選び、Enter で決定、Esc で閉じる。候補は本物のリンク（`<a href="#/...">`）なので、
 * ⌘クリックや「リンクをコピー」も普通に効く。Enter は選んでいるリンクを click() する。
 *
 * 2 つの群がある（#230）:
 * - **セッション**（上）は開いたときの一覧を手元で絞るので、打つたびに即出る
 * - **発言**（下）はサーバに聞くので、**打ち終わってから**届いて下に足される（`useSearch`）
 *
 * ↑↓ は 2 つの群を通しで動く（`rows` に平らに並べてある）ので、境目を意識しなくていい。
 */
export function CommandPalette({ sessions, loading, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const items = useMemo(() => filterPalette(paletteItems(sessions), query), [sessions, query])
  const search = useSearch(query)
  // ↑↓ の対象は 2 つの群を通した並び。DOM の li と同じ数・同じ順にする
  const count = items.length + search.hits.length
  // 候補が減って範囲から出ることがある（打つたびに絞られる）
  const at = Math.min(index, Math.max(count - 1, 0))

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /** 選択を動かして、見えるところまでスクロールする（長い一覧で ↓ を押し続けたとき） */
  const move = (direction: 'prev' | 'next') => {
    const to = moveIndex(at, count, direction)
    setIndex(to)
    listRef.current?.querySelectorAll('li.pick')[to]?.scrollIntoView({ block: 'nearest' })
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
      listRef.current?.querySelectorAll('li.pick')[at]?.querySelector('a')?.click()
    }
  }

  const short = query.trim().length > 0 && query.trim().length < MIN_QUERY_LENGTH
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="セッションと発言を検索" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          placeholder="セッション名か発言の中身で検索（↑↓ で選んで Enter、Esc で閉じる）"
          aria-label="検索"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
        />
        <ul className="mention palette-list" id="palette-list" role="listbox" aria-label="候補" ref={listRef}>
          {count === 0 && !search.busy && <li className="none">該当するものがありません</li>}
          {items.map((item, i) => (
            <li
              key={item.kind === 'feed' ? 'feed' : item.id}
              className={`pick${i === at ? ' active' : ''}`}
              role="option"
              aria-selected={i === at}
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
          {/* 発言の当たり。押すとそのセッションを開いて、当たった発言まで送る（#/s/<id>?ts=…） */}
          {search.hits.length > 0 && <li className="group-head">発言 {search.truncated ? `${search.hits.length}+ 件` : `${search.hits.length} 件`}</li>}
          {search.hits.map((hit, i) => {
            const n = items.length + i
            return (
              <li
                key={`${hit.id}:${hit.ts}:${hit.who}`}
                className={`pick said${n === at ? ' active' : ''}`}
                role="option"
                aria-selected={n === at}
                onMouseEnter={() => setIndex(n)}
              >
                <a href={sessionHash(hit.id, hit.ts)} title={hit.id} onClick={onClose} tabIndex={-1}>
                  <span className="said-head">
                    {hit.icon && <img className="icon" src={hit.icon} alt="" width={16} height={16} />}
                    <b>{hit.label}</b>
                    <span className="title">{hit.hint}</span>
                    <span className="who">{hit.who === 'me' ? 'あなた' : 'エージェント'}</span>
                    <span className="when">{hm(hit.ts)}</span>
                    {hit.archived && <span className="tag archived">アーカイブ</span>}
                  </span>
                  <span className="said-body"><Highlight text={hit.excerpt} hits={hit.hits} /></span>
                </a>
              </li>
            )
          })}
        </ul>
        {short && <div className="hint">発言の検索は 2 文字から</div>}
        {!short && search.busy && <div className="hint">発言を探しています…</div>}
        {!short && !search.busy && search.error && <div className="hint">発言の検索に失敗しました: {search.error}</div>}
        {!short && !search.busy && !search.error && search.hits.length === 0 && search.scanned > 0 && (
          <div className="hint">発言には見つかりませんでした（直近 90 日の {search.scanned} 行を見ました）</div>
        )}
        {!short && search.truncated && <div className="hint">発言は多いので新しい方から出しています</div>}
        {loading && <div className="hint">絞り込み中の一覧から出しています（全部を取りに行っています）</div>}
      </div>
    </div>
  )
}
