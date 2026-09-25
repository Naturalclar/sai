import { projectName } from '../../shared/project.ts'
import type { TodoItem } from '../../shared/todoItems.ts'
import { ApprovalBubble } from './ApprovalBubble'
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
}

/**
 * 「要対応」の 1 行（#224）。上段（`answer` / `watch`）でも下段（`done`。#438）でも同じ形で出す。
 *
 * 違うのは**印と添え書き**だけ: `done` は詰まっていないので「待っている」ではなく「終わっている」と言い、
 * できることも「答える」ではなく「次を送る」になる。
 */
export function TodoRow({ item, now, hotkey, modeNote }: Props) {
  const s = item.session
  const label = s ? s.meta?.name || s.title || s.id : item.id
  const where = s ? projectName(s.project) || s.repo : ''
  const waited = elapsedLabel(item.since, now)
  const done = item.kind === 'done'
  return (
    <div className={`todo ${item.kind}`}>
      <a className="who" href={`#/s/${encodeURIComponent(item.id)}`} title={item.id}>
        {s?.icon && <img className="icon" src={s.icon} alt="" />}
        <span className="name">{label}</span>
        {where && <span className="where">#{where}</span>}
        {waited && <span className="waited">{done ? `終わってから ${waited}` : `${waited} 待っている`}</span>}
      </a>
      {item.kind === 'answer' && item.approval ? (
        // 答えるとサーバの approvals から消え、次のポーリングでこの行ごと消える。
        // **同じセッションに次の許可が並んでいれば、この行は消えずに中身だけ次の許可に替わる**（行の key は
        // セッション ID）ので、許可ごとに作り直す。付けないと押した直後の「拒否した」が次の許可に残って押せない（#492）
        <ApprovalBubble key={item.approval.approval_id} approval={item.approval} now={now} hotkey={hotkey} modeNote={modeNote} />
      ) : (
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
          {/* 選択肢は SAI に届いていないのでボタンは出せないが、返信欄からは打てる（#232） */}
          <span className="note">{noteFor(done, item.replyable)}</span>
        </div>
      )}
    </div>
  )
}

/** その行でできること。`done` は「答える」ではなく「次を送る」 */
function noteFor(done: boolean, replyable: boolean): string {
  if (done) return replyable ? '開いて次の指示を送れます' : '端末で続きを打ってください'
  return replyable ? '開いて返信欄から答えられます' : '端末で答えてください'
}
