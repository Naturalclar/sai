import { quoteInsert } from './quoteReply'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { answerableIds } from './terminalQuestion.ts'
import { canSteer, replyBlockedReason } from '../../shared/reply.ts'
import { launchedModeNote } from '../../shared/permissions.ts'
import { RECENT_DAYS } from '../../shared/recentRows.ts'
import { promptArrived } from './chatGroups'
import { api } from './api'
import type { SessionSummary } from './api'
import { useLocalState, usePolling } from './hooks'
import type { MessageSide } from './hooks'
import { Chat } from './Chat'
import { OlderRowsButton } from './OlderRowsButton'
import { PendingBubble } from './PendingBubble'
import { InterruptButton } from './InterruptButton'
import { ProgressNotes } from './ProgressNotes'
import { ProgressSteps } from './ProgressSteps'
import { ProgressTodos } from './ProgressTodos'
import { useProgress } from './useProgress'
import { codexTurnSince, openPromptSince } from './openPrompt'
import { isRemoteHost } from '../../shared/host.ts'
import { QueuedBubble } from './QueuedBubble'
import { AgentActivityBar } from './AgentActivityBar'
import { LoopBar } from './LoopBar'
import { LoopForm } from './LoopForm'
import { loopLive } from '../../shared/loops.ts'
import { withAgentReplies } from './agentReplies'
import { replyFooter, withJustSent } from './replyAcross'
import type { JustSent } from './replyAcross'
import { AgentReplyFooter } from './AgentReplyFooter'
import { TodoReplyBox } from './TodoReplyBox'
import { reportDigestUsage } from './digestUsage'
import { followupHead } from '../../shared/agentMessages.ts'
import { EMPTY_DRAFT, loadDraft, saveDraft } from './replyDrafts'
import { restoresText } from './replyRestore'
import { BackgroundAttachBar } from './BackgroundAttachBar'
import { shouldQueue } from './replyQueue.ts'
import { ApprovalBubble } from './ApprovalBubble'
import { AnsweredApprovals } from './AnsweredApprovals'
import { ReplyBox } from './ReplyBox'
import type { RestoreRequest } from './replyRestore'
import { BackLink } from './BackLink'
import { useReply } from './useReply'
import { historyFrom, withOlder } from './replyHistory'
import { ReplaceConfirm } from './ReplaceConfirm'
import { NewSessionStarting } from './NewSessionStarting'
import { HandoffReadyNote } from './HandoffReadyNote'
import { handoffReady, HANDOFF_PROMPT } from '../../shared/handoff.ts'
import { SessionStatusTags } from './SessionStatusTags'
import { SessionHeadInfo } from './SessionHeadInfo'
import { SessionHeadActions } from './SessionHeadActions'
import { SessionHeadMenu } from './SessionHeadMenu'
import { SessionTitle } from './SessionTitle'
import { headName, headTags } from './headTags'
import { ArchiveReturnNote } from './ArchiveReturnNote'
import { newerSibling, returnedFromArchive } from '../../shared/archiveReturn.ts'
import { withSuffix } from '../../shared/sessionLabels.ts'
import { useNarrow } from './useNarrow'
import { useDiffSummary } from './useDiffSummary'
import { useGallery } from './useGallery'
import { imagesByBubble } from '../../shared/gallery.ts'
import { hasDiff } from './diffCount'
import { latestTurnMs, unreadFromMark } from '../../shared/unread.ts'
import { readToSend } from './unreadMarks.ts'
import type { PaneProps } from './App'

const NO_ROWS: never[] = []
const NO_PROMPTS: string[] = []
const NO_REPLYING = {}
const NO_APPROVALS: never[] = []
const NO_FOLLOWUPS: never[] = []
const NO_TARGETS: Readonly<Record<string, readonly string[]>> = {}

/** 返答のバブルの下から相手へ送る返信（#700）の、この画面だけの状態 */
interface Across {
  /** どのセッションの画面の状態か（別のセッションに移ったら捨てる） */
  from: string
  /** 開いている入力欄（1 つだけ）。相手と、どのバブルの下か */
  open: { target: string; anchor: string } | null
  /** この画面から送った相手 → 最後に送ったバブル（その塊の行の `ts`）。確認・失敗を拾うのはこの相手のぶんだけで、失敗はそのバブルの下にだけ出す */
  sentTo: Readonly<Record<string, readonly string[]>>
  /** 送った直後の、サーバの応答にまだ載っていない行 */
  just: JustSent[]
  restore?: { target: string } & RestoreRequest
  /** 案の 1 押しを送っている最中 */
  quick: boolean
}
const noAcross = (from: string): Across => ({ from, open: null, sentTo: NO_TARGETS, just: [], quick: false })

/** 差分のペインの開閉（#211）。ボタンは入力欄の上に浮かせるので、セッション画面だけが受け取る（#351） */
export interface DiffProps {
  /** そのセッションの差分を開く／閉じる。出し方（右のペイン / モーダル）は App が幅で決める */
  onToggleDiff: (id: string) => void
  /** いま差分を出しているか */
  diffOpen: boolean
  /** 差分へのコメント（#511）を返信欄に入れる頼み。`seq` が増えたときだけ入る */
  insert?: RestoreRequest
  /**
   * フォーカスのあるペインか（#633。省くと true）。許可の ⌘Enter を受けるのはフォーカスのあるペインだけ
   * （同じ形の許可が 2 つのペインに出ていても、押した 1 回で両方を通さない）
   */
  focused?: boolean
}

export function SessionView({ id, focusTs = '', focusSide, onStatus, onOpenSidebar, onToggleDiff, diffOpen, insert, focused = true, onLeaveToSidebar, linear, settings, peers }: { id: string; focusTs?: string; focusSide?: MessageSide; peers?: readonly SessionSummary[] | undefined } & PaneProps & DiffProps) {
  // 描く行は直近 RECENT_DAYS 日から（#477）。「前の 7 日を表示」で広げ、別のセッションに移ったら戻す（描画中に導く）
  const [wide, setWide] = useState({ id, days: RECENT_DAYS })
  const recent = wide.id === id ? wide.days : RECENT_DAYS
  const { data, error, updatedAt } = usePolling(() => api.session(id, { recent, focus: focusTs }), [id, recent, focusTs], { resetKey: id })
  useEffect(() => onStatus(updatedAt, error), [updatedAt, error, onStatus])

  // 返信先はこのセッションだけなので、行数はこの画面のターン完了の行数（入力の行は返信の終わりではない）。
  // 描いている行ではなく集計から数える（「前の 7 日を表示」で行が増えたのを返信の終わりと取り違えない）
  const turns = data?.session.turns ?? 0
  // 返答のバブルの下から相手へ送る返信（#700）も同じ `useReply` で送る。相手の行数は詳細に載っている相手のセッションから
  const targets = useMemo(() => new Map((data?.agent_reply_sessions ?? []).map((t) => [t.id, t])), [data?.agent_reply_sessions])
  const { pending, failed, steered, noted, send, confirm, confirmedSentBy, confirmReplace, confirmProcess, cancelConfirm } = useReply((target) => (target === id ? turns : (targets.get(target)?.turns ?? 0)), data?.replying ?? NO_REPLYING, updatedAt)
  const mine = pending.find((p) => p.id === id) ?? null
  const now = updatedAt?.getTime() ?? 0
  const failedHere = failed && failed.id === id ? failed : null
  // 非同期に失敗した返信を入力欄に戻す（#350）。押したときだけ流し込む
  const [restore, setRestore] = useState<RestoreRequest | null>(null)
  // 返答のバブルの下の返信（#700）。開いている入力欄は 1 つだけ（相手とバブルで覚える）。別のセッションに移ったら忘れる
  // （`from` が今の id でないものは無いものとして扱う。effect で setState しない）
  const [across, setAcross] = useState<Across>(() => noAcross(id))
  const acrossHere = across.from === id ? across : noAcross(id)
  const patchAcross = (patch: (a: Across) => Partial<Across>) =>
    setAcross((a) => {
      const base = a.from === id ? a : noAcross(id)
      return { ...base, ...patch(base) }
    })
  const targetBusy = (target: string) => pending.some((p) => p.id === target) || (data?.queued[target]?.items.length ?? 0) > 0
  // 相手へ送る。送る仕組みは自分への返信と同じ（処理中・預かりが残っていれば預ける）。送り元の画面から送った印だけ添える
  const sendAcross = async (target: string, tss: readonly string[], text: string, attachments: string[]): Promise<boolean> => {
    const anchor = tss[tss.length - 1] ?? ''
    patchAcross((a) => ({ sentTo: { ...a.sentTo, [target]: tss } }))
    const outcome = await send(target, text, { attachments, queue: shouldQueue(pending.some((p) => p.id === target), data?.queued[target]?.items.length ?? 0), sentFrom: { id, anchor } })
    if (outcome !== 'sent') return false
    patchAcross((a) => ({ open: null, just: withJustSent(a.just, data?.agent_followups ?? NO_FOLLOWUPS, { to: target, anchor, text: followupHead(text), at: Date.now() }, tss) }))
    return true
  }
  // 自分への返信の確認・失敗だけを下の入力欄の近くに出す。相手への分は、この画面から送った相手のものだけバブルの下に出す
  const confirmHere = confirm && (confirm.id === id || acrossHere.sentTo[confirm.id] !== undefined) ? confirm : null
  const fromConfirm = async (run: () => Promise<string>) => {
    const target = confirm?.id
    if ((await run()) !== 'sent' || !target || target === id) return
    // 相手への送り直しが受け付けられたら、その入力欄を閉じる。閉じると相手の `ReplyBox` は増えた数（`confirmedSentBy`）を
    // 見ないまま外れるので、戻してあった打ちかけはここで消す（残すと、相手のセッション画面や要対応で同じ本文をもう一度送れる。#338）
    saveDraft(target, EMPTY_DRAFT)
    patchAcross(() => ({ open: null }))
  }

  const approvals = data?.approvals[id] ?? NO_APPROVALS
  // SAI で答えられる質問のあるセッション。行に載った選択肢を読むだけで重ねて出さない（#334）
  const answerable = useMemo(() => (data ? answerableIds(data.approvals, data.replying) : undefined), [data])
  // 処理中に送って預かっている返信（#305）
  const queuedHere = data?.queued[id]
  const queuedCount = queuedHere?.items.length ?? 0
  // `claude --bg` で回っている・許可を待っているあいだは預ける（#462。サーバは預かったぶんを入力待ちになってから回す）
  const bgBusy = !!data?.background?.live && data.background.status !== 'idle'

  // 処理中のターンがいま何をしているか（#302）。SAI から送った返信を処理中か、端末で打った入力のあとターン完了がまだのときだけ取る。
  // 端末で打ったターンは SAI が起動していないので、transcript の上で本当に動いているか（active）で出す
  const promptSince = mine ? '' : openPromptSince(data?.rows ?? NO_ROWS)
  // 端末で打った Codex のターン（#693）。Codex は入力の行を書かないので、行からは「動いているか」が分からない。
  // このマシンの Codex のセッションを出している間は progress を取り、rollout の開いているターンを見る（読むのは末尾だけで、変わらなければ組み直さない）
  const codexWatch = Boolean(data && !mine && !promptSince && data.session.agent === 'codex' && !data.session.archived && !isRemoteHost(data.session.host, data.host))
  const progress = useProgress(id, Boolean(mine) || Boolean(promptSince) || codexWatch)
  const typedSince = promptSince || (codexWatch ? codexTurnSince(data?.rows ?? NO_ROWS, progress) : '')

  // 思考の折りたたみを全部開いておくか。localStorage に残る。思考のある行が1つも無ければトグルは出さない
  const [thinkingUi, setThinkingUi] = useLocalState<{ open: boolean }>('sai.thinking', { open: false })
  const hasThinking = data?.rows.some((r) => Boolean(r.thinking?.trim())) ?? false

  // ↑ で呼び戻す履歴。行の user_text から作り、送った直後のまだ届いていない分を先頭に足す
  // 描いていない前の行の入力（older_prompts）も後ろに足す（#477。無いと 7 日より前の入力が ↑ で出ない）
  const history = useMemo(
    () => withOlder(historyFrom(data?.rows ?? NO_ROWS, id, mine ? [mine.text] : []), data?.older_prompts ?? NO_PROMPTS),
    [data?.rows, data?.older_prompts, id, mine],
  )

  const s = data?.session
  const blocked = s ? replyBlockedReason(s, data?.host ?? '') : ''
  // 差分ボタンに出す行数と PR 番号（#211）。ポーリングには載せず、開いたときと新しいターンが記録されたときだけ取る
  const summary = useDiffSummary(s?.id, s?.last_turn_ts)
  // 会話に出てきた画像（#504）。差分と同じく、開いたときと新しい発言が記録されたときだけ取り、出てきた発言のバブルの下に出す（#507）
  const gallery = useGallery(s?.id, `${s?.last_turn_ts ?? ''}|${s?.last_user_ts ?? ''}`)
  const bubbleImages = useMemo(() => imagesByBubble(gallery), [gallery])
  // 送ったメッセージへの返答（#588）。送り元が待たずにターンを終えても、この画面に並ぶ
  const chatRows = useMemo(() => (data ? withAgentReplies(data.rows, data.agent_replies) : []), [data])

  // 未読（#502）。線は**開いたときの印**に引く（読んだそばから印が進むので、今の印に引くとすぐ消える）。
  // 別のセッションに移ったら覚え直す（描画中に合わせる。effect の中で setState しない）
  const [opened, setOpened] = useState<{ id: string; at: number | undefined; held: boolean } | null>(null)
  if (s && s.id === id && opened?.id !== id) setOpened({ id, at: s.read_at, held: false })
  const openedHere = opened?.id === id ? opened : null
  // 送った既読の時刻。同じ時刻を 3 秒ごとに送り直さない
  const sentRead = useRef({ id: '', ms: 0 })
  const rows = data?.rows
  const readAt = s?.read_at
  const held = openedHere?.held ?? false
  const onSeenBottom = useCallback(() => {
    if (!rows) return
    const want = readToSend(latestTurnMs(rows), readAt, sentRead.current.id === id ? sentRead.current.ms : 0, held)
    if (want === null) return
    sentRead.current = { id, ms: want }
    api.markRead(id, { ts: new Date(want).toISOString() }).catch(() => {
      sentRead.current = { id, ms: 0 } // 次の描き直しでもう一度
    })
  }, [rows, readAt, held, id])
  // 「ここから未読にする」。線もそこへ動かし、このセッションを離れるまで自動の既読を止める
  const onMarkUnread = useCallback((ts: string) => {
    setOpened({ id, at: unreadFromMark(ts), held: true })
    void api.markRead(id, { ts, back: true }).catch(() => undefined)
  }, [id])

  // 狭い画面では見出しを「← 名前 状態の印 ⋯」と題名 1 行に畳み、詳しい情報と操作は ⋯ のパネルへ（#274。
  // 見出しだけで 283px あり、スクロールしない場所なのでチャットが画面の 1/3 を切っていた）
  // 返答の一部の引用（#604）。押すたびに seq を進め、ReplyBox が打ちかけの後ろへ足す（送らない）。
  // ReplyBox は key でセッションごとに作り直され、作ったときの seq は当てた扱いにするので、別のセッションには持ち越さない
  const [quote, setQuote] = useState<RestoreRequest | null>(null)
  const canQuote = Boolean(s && !s.archived && !blocked)
  const narrow = useNarrow()
  const contextTokens = data?.context_tokens ?? 0
  // 「新しいセッションで送る」（#579）。表示名・アイコン・一言の性格を引き継いで始め、最初の記録が届いたらそちらへ移る。
  // 前のセッションは消さない・アーカイブしない
  const [fresh, setFresh] = useState<{ from: string; id: string; text: string; since: number } | null>(null)
  const [freshError, setFreshError] = useState('')
  const startFresh = async (text: string): Promise<boolean> => {
    setFreshError('')
    try {
      const res = await api.startSession({ from: id, text, inherit: true, ...(s?.meta?.model ? { model: s.meta.model } : {}) })
      setFresh({ from: id, id: res.id, text, since: Date.now() })
      return true
    } catch (err) {
      setFreshError(err instanceof Error ? err.message : String(err))
      return false
    }
  }
  // 引き継いで新しいセッション（#442）。1) 引き継ぎを書かせる 1 ターンを普通の返信として送る 2) 書けたら（最後のターンが
  // その返答なら）入力欄の下に「この引き継ぎで始める」を出す。**判定は行から**（`handoffReady()`）なので、画面を閉じても残る
  const canHandoff = Boolean(s && s.agent === 'claude' && !s.archived && !blocked)
  const onHandoff = canHandoff ? () => void send(id, HANDOFF_PROMPT, { queue: shouldQueue(mine !== null || bgBusy, queuedCount) }) : undefined
  const handoff = canHandoff && data ? handoffReady(data.rows) : null
  const handoffOpen = handoff !== null && s?.meta?.continued_at !== handoff.ts && mine === null
  const startHandoff = async (): Promise<boolean> => {
    setFreshError('')
    try {
      const res = await api.startSession({ from: id, text: '', handoff: true })
      setFresh({ from: id, id: res.id, text: '（前のセッションからの引き継ぎ）', since: Date.now() })
      return true
    } catch (err) {
      setFreshError(err instanceof Error ? err.message : String(err))
      return false
    }
  }
  // ループ（#634）。組めるのは Claude の、端末で開いていない、返信できるセッション（サーバも同じ理由で断る）
  const loop = data?.loops[id]
  const [loopFormFor, setLoopFormFor] = useState('')
  const canLoop = Boolean(s && s.agent === 'claude' && !s.archived && !blocked && !s.terminal && !(loop && loopLive(loop.status)))
  const onLoop = canLoop ? () => setLoopFormFor(id) : undefined
  const tagInput = { serverHost: data?.host ?? '', approval: approvals[0]?.text ?? '', replyingSince: mine?.since ?? '', contextTokens }
  const thinking = { has: hasThinking, open: thinkingUi.open, toggle: () => setThinkingUi({ open: !thinkingUi.open }) }
  const label = s ? headName(s) : { name: '', project: '' }
  const returned = s ? returnedFromArchive(s) : ''
  const sibling = s && returned ? newerSibling(s, peers ?? []) : undefined
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
              <SessionHeadInfo s={s} contextTokens={contextTokens} />
              <span className="meta wide head-id">
                <code>{s.id}</code>
                {s.session_source && s.session_source !== 'synth' && <span className="tag">{s.session_source}</span>}
              </span>
              <SessionHeadActions s={s} settings={settings} thinking={thinking} peers={peers} onHandoff={onHandoff} onLoop={onLoop} />
            </SessionHeadMenu>
          </div>
          {s.title_full && <SessionTitle key={`title:${s.id}`} text={s.title_full} />}
        </div>
      )}
      {s && !narrow && (
        <div className="chat-head">
          {/* bare clone だと repo は worktree 名なので、リポジトリ名（project）。worktree は右の branch で分かる */}
          <h1><span className="hash">#</span>{label.project}</h1>
          <SessionHeadInfo s={s} contextTokens={contextTokens} />
          <SessionStatusTags tags={headTags(s, { ...tagInput, compact: false })} now={now} title={s.id} />
          <SessionHeadActions s={s} settings={settings} thinking={thinking} peers={peers} onHandoff={onHandoff} onLoop={onLoop} />
          {s.title_full && <div className="meta wide">{s.title_full}</div>}
        </div>
      )}
      {error && !data && <div className="empty">{error}</div>}
      {data && (
        <Chat
          rows={chatRows}
          leader={data.older > 0 ? <OlderRowsButton count={data.older} days={RECENT_DAYS} onMore={() => setWide({ id, days: recent + RECENT_DAYS })} /> : undefined}
          showChannel={false}
          sessions={[data.session]}
          // 返答の一部を引用して返信欄に入れる（#604）。返信欄を出しているときだけ
          {...(canQuote ? { onQuote: (selected: string) => setQuote((q) => ({ text: quoteInsert(selected), seq: (q?.seq ?? 0) + 1 })) } : {})}
          {...(answerable ? { answerable } : {})}
          profile={data.profile}
          linear={linear}
          showThinking
          thinkingOpen={thinkingUi.open}
          // 長い本文は最初から開いた状態で出す（#369。フィードと揃える。畳むのはボタン 1 つ）
          longOpen
          focusTs={focusTs}
          images={bubbleImages}
          {...(openedHere ? { unreadAfter: openedHere.at } : {})}
          onSeenBottom={onSeenBottom}
          onMarkUnread={onMarkUnread}
          {...(focusSide ? { focusSide } : {})}
          {...(data.question ? { question: data.question } : {})}
          renderReplyFooter={(target, tss, toName) => {
            const session = targets.get(target)
            const anchor = tss[tss.length - 1] ?? ''
            const footer = replyFooter({ target, tss, session, toName, followups: data.agent_followups ?? NO_FOLLOWUPS, justSent: acrossHere.just, targetBusy: targetBusy(target), host: data.host })
            const open = acrossHere.open?.target === target && tss.includes(acrossHere.open.anchor)
            // 失敗の案内は、送ったバブルの下にだけ（同じ相手の返答が並んでいても 1 か所）
            const failedThere = failed && failed.id === target && acrossHere.sentTo[target]?.some((ts) => tss.includes(ts)) ? failed : null
            return (
              <AgentReplyFooter
                key={`footer:${target}:${anchor}`}
                footer={footer}
                open={open}
                sending={acrossHere.quick}
                onToggle={() => patchAcross(() => ({ open: open ? null : { target, anchor } }))}
                onQuick={(text) => {
                  // 案を使ったことを一言の口の集計に残す（入力欄の案を入れて送ったときと同じ）
                  reportDigestUsage(`${target}|${session?.last_turn_ts ?? ''}`, 'next_ask_accepted')
                  patchAcross(() => ({ quick: true }))
                  void sendAcross(target, tss, text, []).finally(() => patchAcross(() => ({ quick: false })))
                }}
              >
                {open && session && footer.canReply && (
                  <TodoReplyBox
                    session={session}
                    // 押して開いた塊のままのときだけ。同じ塊に次の返答が届くと footer ごと作り直されるので、常に付けると打っている別の欄からフォーカスを奪う
                    focusOnOpen={acrossHere.open?.anchor === anchor}
                    replying={data.replying[target]}
                    queued={data.queued[target]?.items.length ?? 0}
                    sentFromConfirm={confirmedSentBy[target] ?? 0}
                    {...(acrossHere.restore?.target === target ? { restore: acrossHere.restore } : {})}
                    onSend={(text, attachments) => sendAcross(target, tss, text, attachments)}
                  />
                )}
                {failedThere && (
                  <div className="notice error reply-failed">
                    <span>送信失敗: {failedThere.message}</span>
                    {failedThere.text && (
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => {
                          // 開いていればその場で流し込む。閉じていれば打ちかけに書いてから開く（ReplyBox は作ったときの restore を当てた扱いにする）
                          if (open) return patchAcross((a) => ({ restore: { target, text: failedThere.text, seq: (a.restore?.seq ?? 0) + 1 } }))
                          const draft = loadDraft(target)
                          if (restoresText(draft.text)) saveDraft(target, { ...draft, text: failedThere.text })
                          patchAcross(() => ({ open: { target, anchor } }))
                        }}
                      >
                        入力欄に戻す
                      </button>
                    )}
                  </div>
                )}
              </AgentReplyFooter>
            )
          }}
          trailer={
            <>
              {/* いまのターンの間に画面から答えた許可（#693）。バブルは答えると消えるので、何を答えたかを残す */}
              {data.answered && <AnsweredApprovals list={data.answered} />}
              {mine && (
                <PendingBubble
                  text={mine.text}
                  since={mine.since}
                  now={now}
                  // 要約だけのターン（#579）は本文（/compact …）を出さず「要約中」の 1 行。本文は預かりのバブルに出る
                  quiet={Boolean(mine.compact) || promptArrived(data.rows, id, mine.text, mine.since)}
                  {...(mine.compact ? { label: '要約中' } : {})}
                  profile={data.profile}
                >
                  <ProgressSteps progress={progress} since={mine.since} now={now} />
                  {/* エージェント自身の段取り（#397。OpenCode だけ。無ければ出ない） */}
                  <ProgressTodos progress={progress} />
                  {/* 止められるのは SAI の app-server が回している Codex のターンだけ（#384） */}
                  {mine.interruptible && <InterruptButton id={id} />}
                </PendingBubble>
              )}
              {/* 途中でエージェントが書いた文（#680）。仮バブルと一緒に出て、一緒に消える */}
              {mine && <ProgressNotes progress={progress} since={mine.since} />}
              {/* 端末で打ったターン（#302）。SAI は起動していないので、transcript の上で動いているときだけ「処理中」を出す */}
              {!mine && typedSince && progress?.active && (
                <PendingBubble text="" since={typedSince} now={now} quiet typed>
                  <ProgressSteps progress={progress} since={typedSince} now={now} />
                  <ProgressTodos progress={progress} />
                </PendingBubble>
              )}
              {!mine && promptSince && progress?.active && <ProgressNotes progress={progress} since={promptSince} />}
              {approvals.map((a, i) => (
                <ApprovalBubble key={a.approval_id} approval={a} now={now} hotkey={i === 0 && focused} modeNote={launchedModeNote(data.replying[id], data.session.meta?.permission_mode)} icon={data.session.icon} />
              ))}
              {queuedHere?.items.map((q, i) => (
                <QueuedBubble key={q.queue_id} id={id} item={q} order={i + 1} paused={queuedHere.paused ?? ''} now={now} profile={data.profile} />
              ))}
              {/* このセッションから別のセッションへのメッセージ（#311）。送ったことがあるか止めているときだけ */}
              {data.agent && <AgentActivityBar id={id} activity={data.agent} now={now} />}
              {loop && <LoopBar key={`loop:${id}`} id={id} loop={loop} now={now} />}
              {data.background && <BackgroundAttachBar background={data.background} />}
            </>
          }
        />
      )}
      {loopFormFor === id && canLoop && <LoopForm key={`loopform:${id}`} id={id} onClose={() => setLoopFormFor('')} />}
      {/* アーカイブしたのに返信が続いている（#583）。止めはせず、知らせて「このまま使う」か新しい方へのリンクを出す */}
      {s && returned && (
        <ArchiveReturnNote
          key={`return:${id}:${returned}`}
          id={id}
          at={returned}
          sibling={sibling ? { id: sibling.id, name: withSuffix(sibling.meta?.name || sibling.title || '(無題)', sibling), start: sibling.start } : undefined}
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
            // 相手への返信（#700）を確認から送り直しても、この入力欄は空にしない（数は返信先ごと）
            sentFromConfirm={confirmedSentBy[id] ?? 0}
            repo={s.repo}
            skillsId={id}
            skillsAgent={s.agent}
            history={history}
            // 次に送る文面の案（#371）。入力欄が空のときだけチップに出る
            {...(s.next_ask ? { nextAsk: s.next_ask, nextAskKey: `${s.id}|${s.last_turn_ts ?? ''}` } : {})}
            // Manager が置いた案（#565）。空のときは一言の口の案より先。入れる・捨てるはサーバから取り除くだけ
            {...(s.manager_draft ? { managerDraft: s.manager_draft } : {})}
            onManagerDraft={(action, at) => void api.suggestionAction(id, { action, at }).catch(() => {})}
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
            // 走っている Codex のターンに足せるか（#404。判定はサーバと同じ `canSteer()`）
            steerable={canSteer(s.agent, mine ?? undefined)}
            // 前の返信を処理中か、預かりが残っていれば預ける（#305。先に預けたものを追い越さない）
            {...(restore ? { restore } : {})}
            {...(insert ? { insert } : {})}
            {...(quote ? { quote } : {})}
            // 送れなかった（確認待ち・送信失敗）ら ReplyBox が本文・画像・返信先を戻す（#350）
            // 送り方（#579）。着手の指示なら「要約してから送る」が既定。量は詳細の context_tokens（#441）
            sendMode={{ agent: s.agent, contextTokens, terminal: Boolean(s.terminal) }}
            onSend={async (text, attachments, { steer, mode }) => {
              if (mode === 'new') return await startFresh(text)
              return (await send(id, text, { attachments, queue: shouldQueue(mine !== null || bgBusy, queuedCount), ...(steer ? { steer: true } : {}), ...(mode === 'compact' ? { compact: true } : {}) })) === 'sent'
            }}
          />
        ))}
      {handoffOpen && fresh?.from !== id && <HandoffReadyNote key={`handoff:${id}:${handoff.ts}`} onStart={startHandoff} />}
      {fresh?.from === id && (
        <NewSessionStarting key={`starting:${fresh.id}`} id={fresh.id} text={fresh.text} since={fresh.since} replying={data?.replying[fresh.id]} now={now} onRetry={() => setFresh(null)} />
      )}
      {freshError && <div className="notice error">新しいセッションを始められませんでした: {freshError}</div>}
      {confirmHere && <ReplaceConfirm confirm={confirmHere} onReplace={() => void fromConfirm(confirmReplace)} onProcess={() => void fromConfirm(confirmProcess)} onCancel={cancelConfirm} />}
      {/* 走っているターンに足した（#404）。新しいターンではないので仮バブルは作らず、ここに出す。
          ターンが終われば足した文も記録に載るので、この案内は次に送るかターンが終わると消える */}
      {steered?.id === id && mine !== null && (
        <div className="notice steered">走っているターンに足しました: {steered.text}</div>
      )}
      {noted?.id === id && <div className="notice steered">{noted.message}</div>}
      {failedHere && (
        <div className="notice error reply-failed">
          <span>送信失敗: {failedHere.message}</span>
          {failedHere.text && (
            <button type="button" className="linkish" onClick={() => setRestore((r) => ({ text: failedHere.text, seq: (r?.seq ?? 0) + 1 }))}>
              入力欄に戻す
            </button>
          )}
        </div>
      )}
    </section>
  )
}
