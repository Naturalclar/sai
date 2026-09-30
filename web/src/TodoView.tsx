import { useEffect, useState } from 'react'
import { launchedModeNote } from '../../shared/permissions.ts'
import type { ReplyingMap, SessionsResponse } from './api'
import type { Polled } from './hooks'
import { BackLink } from './BackLink'
import { TodoRow } from './TodoRow'
import { TodoReplyBox } from './TodoReplyBox'
import { ReplaceConfirm } from './ReplaceConfirm'
import { useReply, type ReplyFailed } from './useReply'
import { useNarrow } from './useNarrow'
import { shouldQueue } from './replyQueue.ts'
import { loadDraft, saveDraft } from './replyDrafts'
import { restoresText, type RestoreRequest } from './replyRestore'
import { openRow, ownReplying, rowReplyable } from './todoReply'
import { doneItems, pendingItems, todoItems, type TodoItem } from '../../shared/todoItems.ts'
import type { PaneProps } from './App'

const NO_REPLYING: ReplyingMap = {}

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
 *
 * `watch` / `done` で返信欄から打てるものは、**行の下に返信欄を開いてそのまま次の指示を送れる**（#522。開くのは同時に 1 つ）。
 * 送る仕組みはセッション画面と同じ `useReply`（端末の打ちかけの確認・預かり・失敗したら戻す）で、**ここで持つ**:
 * 送ると行は次のポーリングで「処理中」として消えるので、行の中に持つと失敗を受け取る前に消えてしまう。
 */
export function TodoView({ list, onStatus, onOpenSidebar, onLeaveToSidebar }: Props) {
  const { data, error, updatedAt } = list
  // 自分では取りに行かないが、出しているのはこの取得結果なのでヘッダの「更新 hh:mm」はこれに合わせる
  useEffect(() => onStatus(updatedAt, error), [updatedAt, error, onStatus])

  // replying を渡すのは、別プロセスの返信を処理中なら「待っている」ではなく「動いている」ため（#232）
  const items = data ? todoItems(data.sessions, data.approvals, data.host, data.replying) : []
  // 上段＝答えを待っているもの、下段＝終わって次を待っているだけのもの（#438）
  const pending = pendingItems(items)
  const done = doneItems(items)
  const now = updatedAt?.getTime() ?? 0

  // 行から送る返信（#522）。行数はその返信先のターン完了の数（集計の turns。セッション画面と同じ数え方）
  const replying = data?.replying ?? NO_REPLYING
  // useReply に見せるのは、この画面から送ったセッションのぶんだけ（ほかの画面から送った返信の失敗を拾わない）
  const [sentFrom, setSentFrom] = useState<ReadonlySet<string>>(() => new Set())
  const { pending: sending, failed, send, confirm, confirmedSent, confirmReplace, confirmProcess, cancelConfirm } = useReply(
    (id) => data?.sessions.find((s) => s.id === id)?.turns ?? 0,
    ownReplying(replying, sentFrom),
    updatedAt,
  )
  // 狭い画面では行の下に開かず、セッション画面に移る（入力欄とキーボードで画面がほぼ埋まる）
  const narrow = useNarrow()
  const [openId, setOpenId] = useState<string | null>(null)
  const [restore, setRestore] = useState<{ id: string } & RestoreRequest>()
  // 送った・処理中の返信（行は消えるので、どこに送ったかは上に出す）
  const [sentTo, setSentTo] = useState<{ id: string; label: string } | null>(null)
  // 開いていた行が消えた（送って処理中になった・別の画面で片付いた）ら閉じる。描画中に合わせる（effect で setState しない）
  const openable = new Set(items.filter(rowReplyable).map((t) => t.id))
  if (data && openRow(openId, items) !== openId) setOpenId(null)

  const labelOf = (id: string) => {
    const s = data?.sessions.find((x) => x.id === id)
    return s ? s.meta?.name || s.title || s.id : id
  }
  const sendFrom = async (t: TodoItem, text: string, attachments: string[]) => {
    const queued = data?.queued[t.id]?.items.length ?? 0
    if (!sentFrom.has(t.id)) setSentFrom((prev) => new Set(prev).add(t.id))
    const outcome = await send(t.id, text, { attachments, queue: shouldQueue(false, queued) })
    if (outcome === 'sent') setSentTo({ id: t.id, label: labelOf(t.id) })
    return outcome === 'sent'
  }
  // 失敗した本文を打ちかけ（sai.drafts）に書く。人がもう打ち始めていれば上書きしない
  const keepAsDraft = (f: ReplyFailed) => {
    const draft = loadDraft(f.id)
    if (restoresText(draft.text)) saveDraft(f.id, { ...draft, text: f.text })
  }
  // 失敗した本文を入力欄に戻す（#350）。開いていればその場で、閉じていれば打ちかけに書いてから開く
  // （ReplyBox は作ったときの restore を「当てた」ことにするので、開くのと同時に頼んでも入らない）
  const restoreFailed = (f: ReplyFailed) => {
    if (openId === f.id) {
      setRestore((r) => ({ id: f.id, text: f.text, seq: (r?.seq ?? 0) + 1 }))
      return
    }
    keepAsDraft(f)
    setOpenId(f.id)
  }
  const failedNotice = (f: ReplyFailed) => (
    <div className="notice error reply-failed">
      <span>
        送信失敗{openable.has(f.id) ? '' : `（${labelOf(f.id)}）`}: {f.message}
      </span>
      {f.text &&
        (openable.has(f.id) && !narrow ? (
          <button type="button" className="linkish" onClick={() => restoreFailed(f)}>
            入力欄に戻す
          </button>
        ) : (
          // 行がもう並んでいない（狭い画面では行の下に開かない）ので、打ちかけに書いてセッション画面で開く
          <a className="linkish" href={`#/s/${encodeURIComponent(f.id)}`} onClick={() => keepAsDraft(f)}>
            セッション画面の入力欄に戻す
          </a>
        ))}
    </div>
  )
  const rowOf = (t: TodoItem, key: string, hotkey: boolean, modeNote: string) => {
    const s = t.session
    const replyOk = rowReplyable(t)
    const open = Boolean(replyOk) && !narrow && openId === t.id
    return (
      <TodoRow
        key={key}
        item={t}
        now={now}
        hotkey={hotkey}
        modeNote={modeNote}
        {...(replyOk ? { reply: { inline: !narrow, open, onToggle: () => setOpenId(open ? null : t.id) } } : {})}
      >
        {open && s && (
          <TodoReplyBox
            session={s}
            replying={replying[t.id]}
            queued={data?.queued[t.id]?.items.length ?? 0}
            sentFromConfirm={confirmedSent}
            {...(restore?.id === t.id ? { restore } : {})}
            onSend={(text, attachments) => sendFrom(t, text, attachments)}
            onLeaveToSidebar={onLeaveToSidebar}
          />
        )}
        {failed?.id === t.id && failedNotice(failed)}
      </TodoRow>
    )
  }
  const sentHere = sentTo && sending.some((p) => p.id === sentTo.id) ? sentTo : null

  return (
    <section>
      <BackLink onOpenSidebar={onOpenSidebar} />
      <div className="chat-head">
        <h1>要対応</h1>
        <span className="meta">{data ? (pending.length > 0 ? `${pending.length} 件・待たせている順` : '答えを待っているものはありません') : ''}</span>
      </div>
      {error && !data && <div className="empty">{error}</div>}
      {/* 送った行は「処理中」になって並びから消えるので、どこに送ったかはここに出す（終われば下段に戻る） */}
      {sentHere && <div className="notice">「{sentHere.label}」に送りました。終わるとまた下に並びます</div>}
      {/* 行が消えたあとに届いた失敗（送って処理中になった行は並びに無い） */}
      {failed && !items.some((t) => t.id === failed.id) && failedNotice(failed)}
      {data && items.length === 0 && <div className="empty">エージェントはどれも動いているか、終わっています</div>}
      <div className="todo-list">
        {/* ⌘Enter が効くのは一番上の 1 つだけ（フィードと同じ扱い） */}
        {pending.map((t, i) => rowOf(t, t.id, i === 0, t.session ? launchedModeNote(data?.replying[t.id], t.session.meta?.permission_mode) : ''))}
        {done.length > 0 && (
          <>
            {/* 下段。詰まってはいないので、上段と混ぜない（#438） */}
            <h2 className="todo-section">終わって次を待っている（{done.length}）</h2>
            {done.map((t) => rowOf(t, `done:${t.id}`, false, ''))}
          </>
        )}
      </div>
      {confirm && <ReplaceConfirm confirm={confirm} onReplace={() => void confirmReplace()} onProcess={() => void confirmProcess()} onCancel={cancelConfirm} />}
    </section>
  )
}
