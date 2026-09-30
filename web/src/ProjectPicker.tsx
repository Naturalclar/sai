import { useEffect, useRef, useState } from 'react'
import { moveIndex } from '../../shared/palette.ts'
import { projectsLabel, toggleProject } from '../../shared/projectFilter.ts'
import { projectChoices } from './projectChoices'

interface Props {
  /** いま選んでいるリポジトリ（`Naturalclar/sai`）。空ならすべて */
  selected: readonly string[]
  /** 候補（`/api/sessions` の `filters.projects`。App が取ったものをそのまま） */
  projects: readonly string[]
  onChange: (projects: string[]) => void
  /** ボタンの見た目の置き場（サイドバーの絞り込み・フィードの見出し）。CSS の出し分けだけ */
  place: 'side' | 'feed'
}

/**
 * 表示するリポジトリの切り替え（#215 / #529）。サイドバーとフィードの見出しの 2 か所に出るが、
 * 触るのは**同じ `filters.projects`**（絞り込みが 2 つに増えるわけではない）。
 * 狭い画面では一覧とフィードが別画面なので、フィード側に口が無いとリポジトリを変えるのにサイドバーまで戻ることになる。
 *
 * **複数選べる**（#529）。項目を押すと入れ外しし、メニューは開いたまま（続けて選べるように）。
 * 先頭の「すべて」は選んだものを全部外す。閉じているときは短い名前（`#sai` / `#sai +2`）、
 * メニューには `owner/repo` の全体を出す（別のオーナーの同名リポジトリと見分けが付かなくなるため）。
 * ↑↓ Enter Esc はメニューの中で使い切る（そのまま通すと App のセッション移動が動いてしまう）
 */
export function ProjectPicker({ selected, projects, onChange, place }: Props) {
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // 先頭が「すべて」（空文字）。いま選んでいるものは候補に無くても並べる（外せなくならないように）
  const items = ['', ...projectChoices(projects, selected)]

  const pick = (project: string) => onChange(project ? toggleProject(selected, project) : [])
  // 候補から外れていた選択を外すと並びが短くなる。印を末尾に寄せる（はみ出したまま Enter で「すべて」に落ちないように。#532 のレビュー）
  const at = Math.min(index, items.length - 1)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    // **capture** で document に張る。App のセッション移動は window の bubble なので、ここで止めれば
    // メニューを開けている間の ↑↓ / Esc が裏の一覧を動かさない
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return
      // 選んでもメニューは開いたままなので、フォーカスが外へ出たら（→ や Tab で入力欄へ）閉じてキーは通す。
      // 閉じないと入力欄で打った Enter / Space をここが食べて、リポジトリの入れ外しになる（#532 のレビュー）
      if (!ref.current?.contains(document.activeElement)) {
        setOpen(false)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        buttonRef.current?.focus()
        return
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setIndex((i) => moveIndex(Math.min(i, items.length - 1), items.length, e.key === 'ArrowDown' ? 'next' : 'prev'))
        return
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        pick(items[at] ?? '')
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  })

  const where = place === 'feed' ? 'フィードに出すリポジトリ' : '一覧に出すリポジトリ'
  return (
    <div className={`project-pick ${place}`} ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setIndex(0)
          setOpen((v) => !v)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${where}${selected.length > 0 ? `: ${selected.join(', ')}` : '（いまは全部）'}。押すと変えられる（複数選べる。サイドバーとフィードで同じ絞り込み）`}
      >
        {projectsLabel(selected)}
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((p, i) => {
            const on = p ? selected.includes(p) : selected.length === 0
            return (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                key={p || '(all)'}
                className={`${on ? 'picked' : ''}${i === at ? ' at' : ''}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => pick(p)}
              >
                <span className="check" aria-hidden="true">{on ? '✓' : ''}</span>
                {p || 'すべて'}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
