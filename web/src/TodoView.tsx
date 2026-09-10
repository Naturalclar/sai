import { useEffect } from 'react'
import { projectName } from '../../shared/project.ts'
import { launchedModeNote } from '../../shared/permissions.ts'
import type { SessionsResponse } from './api'
import type { Polled } from './hooks'
import { ApprovalBubble } from './ApprovalBubble'
import { WaitingTag } from './WaitingTag'
import { BackLink } from './BackLink'
import { elapsedLabel } from './format'
import { todoItems } from './todoItems'
import type { PaneProps } from './App'

interface Props extends PaneProps {
  /** 一覧の取得結果。App が 1 回だけ取っているものをそのまま使う（この画面は自分では取りに行かない） */
  list: Polled<SessionsResponse>
}

/**
 * 「要対応」（#224）。**いま自分を待っているものだけ**を待たせている順に並べる。
 * セッションが増えるとサイドバーの「待機中」を目で探すことになり、狭い画面ではなおさら見落とすため。
 *
 * 2 種類あって、見た目で分けている:
 * - **答え待ち**（`answer`）は SAI が口を持っているもので、`ApprovalBubble` をそのまま置くので**ここで答えられる**
 * - **待機中**（`watch`）は記録の行から見た待ち。選択肢が SAI に届いていないのでボタンは出せないが、
 *   **返信欄からは打てることが多い**ので、その会話でできることを出す（`replyable`。#232）
 *
 * データは `/api/sessions` の応答にすべて載っているので、サーバも足していないし取得も増えていない。
 */
export function TodoView({ list, onStatus, onOpenSidebar }: Props) {
  const { data, error, updatedAt } = list
  // 自分では取りに行かないが、出しているのはこの取得結果なのでヘッダの「更新 hh:mm」はこれに合わせる
  useEffect(() => onStatus(updatedAt, error), [updatedAt, error, onStatus])

  // replying を渡すのは、別プロセスの返信を処理中なら「待っている」ではなく「動いている」ため（#232）
  const items = data ? todoItems(data.sessions, data.approvals, data.host, data.replying) : []
  const now = updatedAt?.getTime() ?? 0

  return (
    <section>
      <BackLink onOpenSidebar={onOpenSidebar} />
      <div className="chat-head">
        <h1>要対応</h1>
        <span className="meta">{data ? (items.length > 0 ? `${items.length} 件・待たせている順` : '待っているものはありません') : ''}</span>
      </div>
      {error && !data && <div className="empty">{error}</div>}
      {data && items.length === 0 && <div className="empty">エージェントはどれも動いているか、終わっています</div>}
      <div className="todo-list">
        {items.map((t, i) => {
          const s = t.session
          const label = s ? s.meta?.name || s.title || s.id : t.id
          const where = s ? projectName(s.project) || s.repo : ''
          const waited = elapsedLabel(t.since, now)
          return (
            <div className={`todo ${t.kind}`} key={t.id}>
              <a className="who" href={`#/s/${encodeURIComponent(t.id)}`} title={t.id}>
                {s?.icon && <img className="icon" src={s.icon} alt="" />}
                <span className="name">{label}</span>
                {where && <span className="where">#{where}</span>}
                {waited && <span className="waited">{waited} 待っている</span>}
              </a>
              {t.kind === 'answer' && t.approval ? (
                // 答えるとサーバの approvals から消え、次のポーリングでこの行ごと消える。
                // ⌘Enter が効くのは一番上の 1 つだけ（フィードと同じ扱い）
                // 処理中のターンが今の設定と違う許可モードで動いていれば、聞かれている理由を添える（#272）
                <ApprovalBubble approval={t.approval} now={now} hotkey={i === 0} modeNote={s ? launchedModeNote(data?.replying[t.id], s.meta?.permission_mode) : ''} />
              ) : (
                <div className="why">
                  <WaitingTag text={t.text} />
                  <span className="text">{t.text}</span>
                  {/* 選択肢は SAI に届いていないのでボタンは出せないが、返信欄からは打てる（#232） */}
                  <span className="note">{t.replyable ? '開いて返信欄から答えられます' : '端末で答えてください'}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
