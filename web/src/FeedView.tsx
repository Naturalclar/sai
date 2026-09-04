import { useEffect, useMemo, useState } from 'react'
import { entityId } from '../../shared/entity.ts'
import { eventKind } from '../../shared/events.ts'
import { promptArrived } from './chatGroups'
import { defaultReplyTarget, feedReplyTargets, mergeReplyTargets, sessionReplyTargets } from '../../shared/reply.ts'
import { api, type ApprovalMap, type SessionSummary } from './api'
import { useLocalState, usePolling } from './hooks'
import { Chat } from './Chat'
import { PendingBubble } from './PendingBubble'
import { ApprovalBubble } from './ApprovalBubble'
import { ReplyBox, type Picked } from './ReplyBox'
import { DaysSelect } from './DaysSelect'
import { BackLink } from './BackLink'
import { useReply } from './useReply'
import type { PaneProps } from './App'

const NO_ROWS: never[] = []
const NO_SESSIONS: never[] = []
const NO_REPLYING = {}
const NO_APPROVALS: ApprovalMap = {}

interface Props extends PaneProps {
  repo: string
  /** サイドバーの一覧（App が取ったもの）。@ の候補はこれを主にする。まだ無ければ undefined */
  sessions: SessionSummary[] | undefined
}

/** 全チャンネルを時系列に流す。リポジトリはサイドバーの絞り込みに従い、日数だけここで選ぶ */
export function FeedView({ repo, sessions = NO_SESSIONS, onStatus, onOpenSidebar }: Props) {
  const [local, setLocal] = useLocalState<{ days: string }>('sai.feed', { days: '3' })
  const { data, error, updatedAt } = usePolling(() => api.feed({ repo, days: local.days }), [repo, local.days])
  useEffect(() => onStatus(updatedAt, error), [updatedAt, error, onStatus])

  const rows = data?.rows ?? NO_ROWS
  // 返信先の候補は、サイドバーの一覧（表示名・アイコン付き）を先に、フィードにしか無いセッションを後ろに。
  // 既定の返信先は「一番新しい行のセッション」なのでフィード側の先頭を覚えておく
  const feedTargets = useMemo(() => feedReplyTargets(rows), [rows])
  // 「アーカイブ済みを見る」中はサイドバーの一覧がアーカイブ済みだけになるので、候補にはしない（フィードにも流れていない）
  const targets = useMemo(() => mergeReplyTargets(sessionReplyTargets(sessions.filter((s) => !s.archived)), feedTargets), [sessions, feedTargets])
  // 返信先ごとの行数（「送信中」の解除に使う）はフィードの行から数える
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) {
      // ターン完了の行だけ数える。入力の行（UserPromptSubmit）が増えても返信は終わっていない
      if (eventKind(r.event) !== 'turn') continue
      const id = entityId(r.session, r.repo, r.ts)
      m.set(id, (m.get(id) ?? 0) + 1)
    }
    return m
  }, [rows])

  const { pending: allPending, failed, send } = useReply((id) => counts.get(id) ?? 0, data?.replying ?? NO_REPLYING, updatedAt)
  // サーバの replying にはこの画面の外のセッションも入る。フィードに行があるか、候補に出ているものだけ
  // （一覧にだけあるセッションへ送った直後は、まだフィードに行が無い）
  const pending = allPending.filter((p) => counts.has(p.id) || targets.some((t) => t.id === p.id))
  const busyIds = useMemo(() => new Set(pending.map((p) => p.id)), [pending])
  const now = updatedAt?.getTime() ?? 0

  // 手で選んだ返信先（id と、本文に入れた表記）。候補から消えたら（days やリポジトリの変更）既定に戻る
  const [picked, setPicked] = useState<Picked | null>(null)
  const pickedTarget = picked ? (targets.find((t) => t.id === picked.id && !t.blocked) ?? null) : null
  // 既定は一番新しい行のセッション（再開できて、処理中でないもの）。A に返信しても次の B にそのまま打てる
  const computedDefault = defaultReplyTarget(feedTargets, targets, busyIds)
  // 入力中は既定を動かさない。A の Stop が届いてから子プロセスが exit するまでの数秒で既定が B → A と揺れるので、
  // 打っている途中に返信先が変わらないように、本文が空でない間は最後の既定を持つ（描画中に state を合わせる、React の定石）
  const [drafting, setDrafting] = useState(false)
  const [heldId, setHeldId] = useState<string | null>(null)
  if (!drafting && heldId !== (computedDefault?.id ?? null)) setHeldId(computedDefault?.id ?? null)
  const held = drafting && heldId ? (targets.find((t) => t.id === heldId && !t.blocked) ?? null) : null
  const target = pickedTarget ?? held ?? computedDefault
  const repoOf = (id: string) => targets.find((t) => t.id === id)?.repo
  // 答え待ちの許可・質問も、処理中の返信と同じく、この画面に関係あるものだけ
  const approvals = Object.values(data?.approvals ?? NO_APPROVALS).flat().filter((a) => counts.has(a.id) || targets.some((t) => t.id === a.id))

  return (
    <section>
      <BackLink onOpenSidebar={onOpenSidebar} />
      <div className="chat-head">
        <h1>フィード</h1>
        <span className="meta">{repo ? `#${repo}` : '全リポジトリ'}{data && ` · ${data.rows.length} ターン · 直近${data.days}日`}</span>
        <span className="meta pull">
          <DaysSelect value={local.days} options={[1, 3, 7]} onChange={(days) => setLocal({ days })} />
        </span>
      </div>
      {error && !data && <div className="empty">{error}</div>}
      {data && (
        <Chat
          rows={rows}
          showChannel
          sessions={sessions}
          trailer={
            (pending.length > 0 || approvals.length > 0) && (
              <>
                {pending.map((p) => (
                  <PendingBubble key={p.id} text={p.text} since={p.since} now={now} repo={repoOf(p.id)} quiet={promptArrived(rows, p.id, p.text, p.since)} />
                ))}
                {approvals.map((a) => <ApprovalBubble key={a.approval_id} approval={a} now={now} repo={repoOf(a.id)} />)}
              </>
            )
          }
        />
      )}
      {data &&
        (target ? (
          <ReplyBox
            repo={target.repo}
            busy={pending.some((p) => p.id === target.id)}
            busySince={pending.find((p) => p.id === target.id)?.since}
            now={now}
            onSend={(text) => void send(target.id, text)}
            onDraft={setDrafting}
            mention={{ targets, target, picked: pickedTarget ? picked : null, onPick: setPicked, busyIds }}
          />
        ) : (
          <div className="notice">返信できるセッションがありません</div>
        ))}
      {failed && <div className="notice error">送信失敗（{repoOf(failed.id) ? `#${repoOf(failed.id)}` : failed.id}）: {failed.message}</div>}
    </section>
  )
}
