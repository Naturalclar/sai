import { useState } from 'react'
import { todoCounts, todoNow } from '../../shared/todos.ts'
import type { SessionProgressResponse } from './api'

/** 状態ごとの印。`cancelled` は数に入らないが、開いたときには残しておく（消えたように見えない） */
const MARK: Record<string, string> = { completed: '✓', in_progress: '▶', pending: '·', cancelled: '×' }

/**
 * エージェント自身の段取り（#397。いまは OpenCode だけ）。「処理中 N分」の横に `2/3 件` を出し、
 * 押すと全部の並びが開く。手順（`ProgressSteps`。#302）が「いま何をしているか」で、こちらは
 * **全体のどこまで来たか**。段取りが無ければ何も出さない
 */
export function ProgressTodos({ progress }: { progress: SessionProgressResponse | null }) {
  const [open, setOpen] = useState(false)
  const todos = progress?.todos ?? []
  const children = progress?.children ?? 0
  if (todos.length === 0 && children === 0) return null
  const { done, total } = todoCounts(todos)
  const now = todoNow(todos)
  const label = total > 0 ? `${done}/${total} 件` : ''
  return (
    <div className="progress todos">
      {total > 0 && (
        <button type="button" className="current" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={`${now ? `${now.content}\n` : ''}押すと段取りを開く`}>
          <span className="label">{label}</span>
          {now && <span className="todo-now">{now.content}</span>}
        </button>
      )}
      {/* サブエージェントはまず数だけ（木を描くのは後で。#397） */}
      {children > 0 && <span className="todo-children" title="このターンが起こしたサブセッション">サブ {children}</span>}
      {open && (
        <ol className="steps">
          {todos.map((t, i) => (
            <li key={`${i}:${t.content}`} className={`todo ${t.status}`} title={t.content}>
              <span className="mark">{MARK[t.status] ?? '·'}</span>
              {t.content}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
