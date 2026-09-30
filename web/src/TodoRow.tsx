import type { ReactNode } from 'react'
import { projectName } from '../../shared/project.ts'
import type { TodoItem } from '../../shared/todoItems.ts'
import { ApprovalBubble } from './ApprovalBubble'
import { AgentChip } from './AgentChip'
import { TodoArchiveButton } from './TodoArchiveButton'
import { WaitingTag } from './WaitingTag'
import { elapsedLabel } from './format'

interface Props {
  item: TodoItem
  /** いまの時刻（一覧を取った時刻）。「N 分待っている」の基準 */
  now: number
  /** ⌘Enter を受けるのは描画順の先頭の 1 つだけ（フィードと同じ扱い） */
  hotkey: boolean
  /** 処理中のターンが今の設定と違う許可モードで動いていれば、聞かれている理由（#272） */
  modeNote: string
  /**
   * 行から次の指示を送る口（#522）。渡したときだけ「返信」を出す（`watch` / `done` で `replyable` のもの）。
   * `inline` が false（狭い画面）のときは行の下に開かず、セッション画面へのリンクにする（入力欄で画面がほぼ埋まるため）
   */
  reply?: { inline: boolean; open: boolean; onToggle: () => void }
  /** 行の下に出すもの（開いた返信欄・その行の送信失敗）。TodoView が組み立てる */
  children?: ReactNode
}

/**
 * 「要対応」の 1 行（#224）。上段（`answer` / `watch`）でも下段（`done`。#438）でも同じ形で出す。
 *
 * 違うのは**印と添え書き**だけ: `done` は詰まっていないので「待っている」ではなく「終わっている」と言い、
 * できることも「答える」ではなく「次を送る」になる。
 */
export function TodoRow({ item, now, hotkey, modeNote, reply, children }: Props) {
  const s = item.session
  const label = s ? s.meta?.name || s.title || s.id : item.id
  const where = s ? projectName(s.project) || s.repo : ''
  const waited = elapsedLabel(item.since, now)
  const done = item.kind === 'done'
  // どのエージェントか（#520）。答え待ち（answer）は ApprovalBubble のアバターで分かるので重ねない
  const agent = s && item.kind !== 'answer' ? s.agent || 'unknown' : ''
  return (
    <div className={`todo ${item.kind}`}>
      <a className="who" href={`#/s/${encodeURIComponent(item.id)}`} title={item.id}>
        {s?.icon && <img className="icon" src={s.icon} alt="" />}
        <span className="name">{label}</span>
        {where && <span className="where">#{where}</span>}
        {agent && <AgentChip agent={agent} />}
        {waited && <span className="waited">{done ? `終わってから ${waited}` : `${waited} 待っている`}</span>}
      </a>
      {item.kind === 'answer' && item.approval ? (
        // 答えるとサーバの approvals から消え、次のポーリングでこの行ごと消える。
        // **同じセッションに次の許可が並んでいれば、この行は消えずに中身だけ次の許可に替わる**（行の key は
        // セッション ID）ので、許可ごとに作り直す。付けないと押した直後の「拒否した」が次の許可に残って押せない（#492）
        <ApprovalBubble key={item.approval.approval_id} approval={item.approval} now={now} hotkey={hotkey} modeNote={modeNote} />
      ) : (
        <div className="why-row">
          <div className="why">
            {done ? (
              <span className="tag done" title={item.text}>
                終了
              </span>
            ) : (
              <WaitingTag text={item.text} />
            )}
            {/* 文言は行の text のまま（`入力待ち（バックグラウンドのセッション）` の区別を捨てない） */}
            <span className="text">{item.text}</span>
            {/* 選択肢は SAI に届いていないのでボタンは出せないが、返信欄からは打てる（#232）。
                ここから送れるなら、セッション画面に移らずに行の下で打てる（#522） */}
            {reply && item.replyable ? (
              reply.inline ? (
                <button type="button" className={`linkish todo-reply-open${reply.open ? ' open' : ''}`} aria-expanded={reply.open} onClick={reply.onToggle}>
                  {reply.open ? '返信を閉じる' : done ? '次の指示を送る' : '返信する'}
                </button>
              ) : (
                <a className="todo-reply-open" href={`#/s/${encodeURIComponent(item.id)}`}>
                  {done ? '開いて次の指示を送る' : '開いて返信する'}
                </a>
              )
            ) : (
              <span className="note">{noteFor(done, item.replyable)}</span>
            )}
          </div>
          {/* 終わったものだけ片付けられる（#527）。待っているものを片付けると、止まったまま見えなくなる。
              押したあと次の行が届くとアーカイブは打ち消されて行が残るので、end ごとに作り直して「戻す」の表示を持ち越さない */}
          {done && s && <TodoArchiveButton key={`archive:${s.end}`} id={item.id} />}
        </div>
      )}
      {children}
    </div>
  )
}

/** その行でできること。`done` は「答える」ではなく「次を送る」 */
function noteFor(done: boolean, replyable: boolean): string {
  if (done) return replyable ? '開いて次の指示を送れます' : '端末で続きを打ってください'
  return replyable ? '開いて返信欄から答えられます' : '端末で答えてください'
}
