import { useEffect, useRef, useState } from 'react'
import { moveIndex } from '../../shared/palette.ts'
import { projectName } from '../../shared/project.ts'
import { projectChoices } from './projectChoices'

interface Props {
  /** いま選んでいるリポジトリ（`Naturalclar/sai`）。空なら全部 */
  value: string
  /** 候補（`/api/sessions` の `filters.projects`。App が取ったものをそのまま） */
  projects: readonly string[]
  onChange: (project: string) => void
}

/**
 * フィードの見出しに出すリポジトリの切り替え（#215）。前はここに読むだけで出ていたもので、
 * 触るのは**サイドバーと同じ `filters.project`**（絞り込みが 2 つに増えるわけではない）。
 * 狭い画面では一覧とフィードが別画面なので、これが無いとリポジトリを変えるのにサイドバーまで戻ることになる。
 *
 * 閉じているときは短い名前（`Naturalclar/sai` → `#sai`）、メニューには `owner/repo` の全体を出す
 * （別のオーナーの同名リポジトリと見分けが付かなくなるため）。ReplyModelPicker と同じ扱い。
 * ↑↓ Enter Esc はメニューの中で使い切る（そのまま通すと App のセッション移動が動いてしまう）
 */
export function FeedProjectPicker({ value, projects, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // 先頭が「すべて」（空文字）。候補は projectChoices が組む
  const items = ['', ...projectChoices(projects, value)]

  const pick = (project: string) => {
    setOpen(false)
    buttonRef.current?.focus()
    if (project !== value) onChange(project)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    // **capture** で document に張る。App のセッション移動は window の bubble なので、ここで止めれば
    // メニューを開けている間の ↑↓ / Esc が裏の一覧を動かさない
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return
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
        setIndex((i) => moveIndex(i, items.length, e.key === 'ArrowDown' ? 'next' : 'prev'))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        pick(items[index] ?? '')
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  })

  return (
    <div className="project-pick" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setIndex(Math.max(0, items.indexOf(value)))
          setOpen((v) => !v)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`フィードに出すリポジトリ${value ? `: ${value}` : '（いまは全部）'}。押すと変えられる（サイドバーの絞り込みと同じ）`}
      >
        {value ? `#${projectName(value)}` : '全リポジトリ'}
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((p, i) => (
            <button
              type="button"
              role="menuitem"
              key={p || '(all)'}
              className={`${p === value ? 'picked' : ''}${i === index ? ' at' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(p)}
            >
              {p || 'すべて'}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
