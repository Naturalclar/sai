import { useEffect, useMemo } from 'react'
import { replyBlockedReason } from '../../shared/reply.ts'
import { launchedModeNote } from '../../shared/permissions.ts'
import { eventKind } from '../../shared/events.ts'
import { promptArrived } from './chatGroups'
import { api } from './api'
import { useLocalState, usePolling } from './hooks'
import { Chat } from './Chat'
import { PendingBubble } from './PendingBubble'
import { ProgressSteps } from './ProgressSteps'
import { useProgress } from './useProgress'
import { openPromptSince } from './openPrompt'
import { QueuedBubble } from './QueuedBubble'
import { AgentActivityBar } from './AgentActivityBar'
import { shouldQueue } from './replyQueue.ts'
import { ApprovalBubble } from './ApprovalBubble'
import { ReplyBox } from './ReplyBox'
import { BackLink } from './BackLink'
import { useReply } from './useReply'
import { historyFrom } from './replyHistory'
import { ReplaceConfirm } from './ReplaceConfirm'
import { SessionStatusTags } from './SessionStatusTags'
import { SessionHeadInfo } from './SessionHeadInfo'
import { SessionHeadActions } from './SessionHeadActions'
import { SessionHeadMenu } from './SessionHeadMenu'
import { SessionTitle } from './SessionTitle'
import { headName, headTags } from './headTags'
import { useNarrow } from './useNarrow'
import { useDiffSummary } from './useDiffSummary'
import { hasDiff } from './diffCount'
import type { PaneProps } from './App'

const NO_ROWS: never[] = []
const NO_REPLYING = {}
const NO_APPROVALS: never[] = []

/** 差分のペインの開閉（#211）。ボタンは入力欄の中なので、セッション画面だけが受け取る */
export interface DiffProps {
  /** そのセッションの差分を開く／閉じる。出し方（右のペイン / モーダル）は App が幅で決める */
  onToggleDiff: (id: string) => void
  /** いま差分を出しているか */
  diffOpen: boolean
}

export function SessionView({ id, focusTs = '', onStatus, onOpenSidebar, onToggleDiff, diffOpen, onLeaveToSidebar, linear, settings }: { id: string; focusTs?: string } & PaneProps & DiffProps) {
  const { data, error, updatedAt } = usePolling(() => api.session(id), [id])
  useEffect(() => onStatus(updatedAt, error), [updatedAt, error, onStatus])

  // 返信先はこのセッションだけなので、行数はこの画面のターン完了の行数（入力の行は返信の終わりではない）
  const turns = data?.rows.reduce((n, r) => n + (eventKind(r.event) === 'turn' ? 1 : 0), 0) ?? 0
  const { pending, failed, send, confirm, confirmReplace, confirmProcess, cancelConfirm } = useReply((target) => (target === id ? turns : 0), data?.replying ?? NO_REPLYING, updatedAt)
  const mine = pending.find((p) => p.id === id) ?? null
  const now = updatedAt?.getTime() ?? 0
  const failedHere = failed && failed.id === id ? failed.message : null
  const confirmHere = confirm && confirm.id === id ? confirm : null

  const approvals = data?.approvals[id] ?? NO_APPROVALS
  // 処理中に送って預かっている返信（#305）
  const queuedHere = data?.queued[id]
  const queuedCount = queuedHere?.items.length ?? 0

  // 処理中のターンがいま何をしているか（#302）。SAI から送った返信を処理中か、端末で打った入力のあとターン完了がまだのときだけ取る。
  // 端末で打ったターンは SAI が起動していないので、transcript の上で本当に動いているか（active）で出す
  const promptSince = mine ? '' : openPromptSince(data?.rows ?? NO_ROWS)
  const progress = useProgress(id, Boolean(mine) || Boolean(promptSince))

  // 思考の折りたたみを全部開いておくか。localStorage に残る。思考のある行が1つも無ければトグルは出さない
  const [thinkingUi, setThinkingUi] = useLocalState<{ open: boolean }>('sai.thinking', { open: false })
  const hasThinking = data?.rows.some((r) => Boolean(r.thinking?.trim())) ?? false

  // ↑ で呼び戻す履歴。行の user_text から作り、送った直後のまだ届いていない分を先頭に足す
  const history = useMemo(() => historyFrom(data?.rows ?? NO_ROWS, id, mine ? [mine.text] : []), [data?.rows, id, mine])

  const s = data?.session
  const blocked = s ? replyBlockedReason(s, data?.host ?? '') : ''
  // 差分ボタンに出す行数と PR 番号（#211）。ポーリングには載せず、開いたときと新しいターンが記録されたときだけ取る
  const summary = useDiffSummary(s?.id, s?.last_turn_ts)

  // 狭い画面では見出しを「← 名前 状態の印 ⋯」と題名 1 行に畳み、詳しい情報と操作は ⋯ のパネルへ（#274。
  // 見出しだけで 283px あり、スクロールしない場所なのでチャットが画面の 1/3 を切っていた）
  const narrow = useNarrow()
  const tagInput = { serverHost: data?.host ?? '', approval: approvals[0]?.text ?? '', replyingSince: mine?.since ?? '' }
  const thinking = { has: hasThinking, open: thinkingUi.open, toggle: () => setThinkingUi({ open: !thinkingUi.open }) }
  const label = s ? headName(s) : { name: '', project: '' }
  return (
    <section>
      {/* 狭い画面では見出しの 1 行目に入る。読み込み中と取得に失敗したときは見出しが無いのでここに出す */}
      {!(narrow && s) && <BackLink onOpenSidebar={onOpenSidebar} />}
      {s && narrow && (
        <div className="chat-head compact">
          <div className="head-row">
            <BackLink compact onOpenSidebar={onOpenSidebar} />
            <span className="head-name">
              {s.icon && <img className="icon" src={s.icon} alt="" />}
              {label.name ? <b>{label.name}</b> : <b><span className="hash">#</span>{label.project}</b>}
              {label.name && <span className="project">#{label.project}</span>}
            </span>
            <SessionStatusTags tags={headTags(s, { ...tagInput, compact: true })} now={now} title={s.id} />
            <SessionHeadMenu key={`menu:${s.id}`}>
              <SessionHeadInfo s={s} />
              <span className="meta wide head-id">
                <code>{s.id}</code>
                {s.session_source && s.session_source !== 'synth' && <span className="tag">{s.session_source}</span>}
              </span>
              <SessionHeadActions s={s} settings={settings} thinking={thinking} />
            </SessionHeadMenu>
          </div>
          {s.title_full && <SessionTitle key={`title:${s.id}`} text={s.title_full} />}
        </div>
      )}
      {s && !narrow && (
        <div className="chat-head">
          {/* bare clone だと repo は worktree 名なので、リポジトリ名（project）。worktree は右の branch で分かる */}
          <h1><span className="hash">#</span>{label.project}</h1>
          <SessionHeadInfo s={s} />
          <SessionStatusTags tags={headTags(s, { ...tagInput, compact: false })} now={now} title={s.id} />
          <SessionHeadActions s={s} settings={settings} thinking={thinking} />
          {s.title_full && <div className="meta wide">{s.title_full}</div>}
        </div>
      )}
      {error && !data && <div className="empty">{error}</div>}
      {data && (
        <Chat
          rows={data.rows}
          showChannel={false}
          sessions={[data.session]}
          profile={data.profile}
          linear={linear}
          showThinking
          thinkingOpen={thinkingUi.open}
          focusTs={focusTs}
          trailer={
            <>
              {mine && (
                <PendingBubble text={mine.text} since={mine.since} now={now} quiet={promptArrived(data.rows, id, mine.text, mine.since)} profile={data.profile}>
                  <ProgressSteps progress={progress} since={mine.since} now={now} />
                </PendingBubble>
              )}
              {/* 端末で打ったターン（#302）。SAI は起動していないので、transcript の上で動いているときだけ「処理中」を出す */}
              {!mine && promptSince && progress?.active && (
                <PendingBubble text="" since={promptSince} now={now} quiet typed>
                  <ProgressSteps progress={progress} since={promptSince} now={now} />
                </PendingBubble>
              )}
              {approvals.map((a, i) => (
                <ApprovalBubble key={a.approval_id} approval={a} now={now} hotkey={i === 0} modeNote={launchedModeNote(data.replying[id], data.session.meta?.permission_mode)} />
              ))}
              {queuedHere?.items.map((q, i) => (
                <QueuedBubble key={q.queue_id} id={id} item={q} order={i + 1} paused={queuedHere.paused ?? ''} now={now} profile={data.profile} />
              ))}
              {/* このセッションから別のセッションへのメッセージ（#311）。送ったことがあるか止めているときだけ */}
              {data.agent && <AgentActivityBar id={id} activity={data.agent} now={now} />}
            </>
          }
        />
      )}
      {s &&
        (s.archived ? (
          <div className="notice">アーカイブ済みのセッションには返信できません。続けるなら「戻す」を押してください（端末で続けて新しい行が届けば自動で戻ります）</div>
        ) : blocked ? (
          <div className="notice">{blocked}</div>
        ) : (
          <ReplyBox
            // 打ちかけは返信先ごとに残すので、セッションが変わったら必ず作り直す（#306）。
            // 今も usePolling が id の変化で data を空にして一度外れるが、それは副作用で、id が変わった直後の
            // 1 回の描画では A の data のまま id だけ B になっている。作り直さないと A の打ちかけを B に送れてしまう
            key={`reply:${id}`}
            draftKey={id}
            repo={s.repo}
            skillsId={id}
            history={history}
            onLeaveToSidebar={onLeaveToSidebar}
            attachId={id}
            terminal={Boolean(s.terminal)}
            busy={mine !== null}
            busySince={mine?.since}
            now={now}
            model={{ id: s.id, agent: s.agent, models: s.models, value: s.meta?.model }}
            // 許可モードのフラグを渡せるのは Claude だけ（Codex / OpenCode には渡す先が無い）
            permission={s.agent === 'claude' ? { id: s.id, value: s.meta?.permission_mode, terminal: Boolean(s.terminal), replying: data?.replying[id] } : undefined}
            {...(summary && hasDiff(summary) ? { diff: { summary, open: diffOpen, onToggle: () => onToggleDiff(s.id) } } : {})}
            queued={queuedCount}
            // 前の返信を処理中か、預かりが残っていれば預ける（#305。先に預けたものを追い越さない）
            onSend={async (text, attachments) => (await send(id, text, { attachments, queue: shouldQueue(mine !== null, queuedCount) })) !== 'confirm'}
          />
        ))}
      {confirmHere && <ReplaceConfirm confirm={confirmHere} onReplace={() => void confirmReplace()} onProcess={() => void confirmProcess()} onCancel={cancelConfirm} />}
      {failedHere && <div className="notice error">送信失敗: {failedHere}</div>}
    </section>
  )
}
