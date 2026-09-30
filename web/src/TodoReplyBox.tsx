import type { Replying, SessionSummary } from './api'
import { ReplyBox } from './ReplyBox'
import type { RestoreRequest } from './replyRestore'

interface Props {
  session: SessionSummary
  /** そのセッションのいまの返信（許可モードの「次の返信から」に使う） */
  replying: Replying | undefined
  /** 預かっている返信の数（#305。残っていればボタンが「あとで送る」になる） */
  queued: number
  /** 送る。`false` なら送れなかったので入力欄に戻す（#350） */
  onSend: (text: string, attachments: string[]) => Promise<boolean>
  /** 確認から送り直して受け付けられた回数（#338） */
  sentFromConfirm: number
  restore?: RestoreRequest
  onLeaveToSidebar?: () => void
}

/**
 * 要対応の行の下に開く返信欄（#522）。**中身はセッション画面の `ReplyBox` そのもの**で、要対応用には作り直さない。
 *
 * 打ちかけの鍵（`draftKey`）はセッション画面と同じエンティティ ID なので、ここで打ちかけてセッション画面に移っても
 * 続きから打てる（逆も）。↑ の履歴は出さない（行を取っていないので作る材料が無い。取りに行くと要対応が
 * 「データを取りに行かない画面」でなくなる）。
 */
export function TodoReplyBox({ session: s, replying, queued, onSend, sentFromConfirm, restore, onLeaveToSidebar }: Props) {
  return (
    <div className="todo-reply">
      <ReplyBox
        // 打ちかけは作ったときに 1 回だけ読むので、返信先ごとに作り直す（#306）
        key={`reply:${s.id}`}
        draftKey={s.id}
        sentFromConfirm={sentFromConfirm}
        repo={s.repo}
        skillsId={s.id}
        skillsAgent={s.agent}
        {...(s.next_ask ? { nextAsk: s.next_ask } : {})}
        {...(onLeaveToSidebar ? { onLeaveToSidebar } : {})}
        attachId={s.id}
        terminal={Boolean(s.terminal)}
        busy={false}
        model={{ id: s.id, agent: s.agent, models: s.models, value: s.meta?.model }}
        permission={s.agent === 'claude' ? { id: s.id, value: s.meta?.permission_mode, terminal: Boolean(s.terminal), replying } : undefined}
        queued={queued}
        {...(restore ? { restore } : {})}
        onSend={(text, attachments) => onSend(text, attachments)}
      />
    </div>
  )
}
