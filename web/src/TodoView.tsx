import { useEffect } from 'react'
import { launchedModeNote } from '../../shared/permissions.ts'
import type { SessionsResponse } from './api'
import type { Polled } from './hooks'
import { BackLink } from './BackLink'
import { TodoRow } from './TodoRow'
import { doneItems, pendingItems, todoItems } from '../../shared/todoItems.ts'
import type { PaneProps } from './App'

interface Props extends PaneProps {
  /** 一覧の取得結果。App が 1 回だけ取っているものをそのまま使う（この画面は自分では取りに行かない） */
  list: Polled<SessionsResponse>
}

/**
 * 「要対応」（#224）。**いま自分を待っているものだけ**を待たせている順に並べる。
 * セッションが増えるとサイドバーの「待機中」を目で探すことになり、狭い画面ではなおさら見落とすため。
 *
 * 3 種類あって、見た目で分けている:
 * - **答え待ち**（`answer`）は SAI が口を持っているもので、`ApprovalBubble` をそのまま置くので**ここで答えられる**
 * - **待機中**（`watch`）は記録の行から見た待ち。選択肢が SAI に届いていないのでボタンは出せないが、
 *   **返信欄からは打てることが多い**ので、その会話でできることを出す（`replyable`。#232）
 * - **終わって次を待っている**（`done`。#438）は詰まっていない。同じ段に混ぜると、本当に答えを待っている
 *   ものが埋もれるので**下段に分ける**（バッジ・タブの題名・通知にも数えない）
 *
 * データは `/api/sessions` の応答にすべて載っているので、サーバも足していないし取得も増えていない。
 */
export function TodoView({ list, onStatus, onOpenSidebar }: Props) {
  const { data, error, updatedAt } = list
  // 自分では取りに行かないが、出しているのはこの取得結果なのでヘッダの「更新 hh:mm」はこれに合わせる
  useEffect(() => onStatus(updatedAt, error), [updatedAt, error, onStatus])

  // replying を渡すのは、別プロセスの返信を処理中なら「待っている」ではなく「動いている」ため（#232）
  const items = data ? todoItems(data.sessions, data.approvals, data.host, data.replying) : []
  // 上段＝答えを待っているもの、下段＝終わって次を待っているだけのもの（#438）
  const pending = pendingItems(items)
  const done = doneItems(items)
  const now = updatedAt?.getTime() ?? 0

  return (
    <section>
      <BackLink onOpenSidebar={onOpenSidebar} />
      <div className="chat-head">
        <h1>要対応</h1>
        <span className="meta">{data ? (pending.length > 0 ? `${pending.length} 件・待たせている順` : '答えを待っているものはありません') : ''}</span>
      </div>
      {error && !data && <div className="empty">{error}</div>}
      {data && items.length === 0 && <div className="empty">エージェントはどれも動いているか、終わっています</div>}
      <div className="todo-list">
        {/* ⌘Enter が効くのは一番上の 1 つだけ（フィードと同じ扱い） */}
        {pending.map((t, i) => (
          <TodoRow key={t.id} item={t} now={now} hotkey={i === 0} modeNote={t.session ? launchedModeNote(data?.replying[t.id], t.session.meta?.permission_mode) : ''} />
        ))}
        {done.length > 0 && (
          <>
            {/* 下段。詰まってはいないので、上段と混ぜない（#438） */}
            <h2 className="todo-section">終わって次を待っている（{done.length}）</h2>
            {done.map((t) => (
              <TodoRow key={`done:${t.id}`} item={t} now={now} hotkey={false} modeNote="" />
            ))}
          </>
        )}
      </div>
    </section>
  )
}
