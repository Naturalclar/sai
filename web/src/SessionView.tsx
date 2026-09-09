import { useEffect, useMemo } from 'react'
import { replyBlockedReason } from '../../shared/reply.ts'
import { projectName } from '../../shared/project.ts'
import { eventKind } from '../../shared/events.ts'
import { promptArrived } from './chatGroups'
import { api } from './api'
import { useLocalState, usePolling } from './hooks'
import { dayLabel, hm } from './format'
import { AgentChip } from './AgentChip'
import { RepoLink } from './RepoLink'
import { SynthTag } from './SynthTag'
import { ReplyingTag } from './ReplyingTag'
import { WaitingTag } from './WaitingTag'
import { TerminalTag } from './TerminalTag'
import { Chat } from './Chat'
import { PendingBubble } from './PendingBubble'
import { ApprovalBubble } from './ApprovalBubble'
import { ReplyBox } from './ReplyBox'
import { BackLink } from './BackLink'
import { useReply } from './useReply'
import { historyFrom } from './replyHistory'
import { ReplaceConfirm } from './ReplaceConfirm'
import { MetaEditor } from './MetaEditor'
import { SessionPersonaSelect } from './SessionPersonaSelect'
import { SessionPermissionModeSelect } from './SessionPermissionModeSelect'
import { ModelTag } from './ModelTag'
import { ArchiveButton } from './ArchiveButton'
import { ArchivedTag } from './ArchivedTag'
import { PermissionModeTag } from './PermissionModeTag'
import { PermissionsButton } from './PermissionsButton'
import { DiffButton } from './DiffButton'
import type { PaneProps } from './App'

const NO_ROWS: never[] = []
const NO_REPLYING = {}
const NO_APPROVALS: never[] = []

export function SessionView({ id, onStatus, onOpenSidebar, onOpenDiff, onLeaveToSidebar, linear, settings }: { id: string } & PaneProps) {
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

  // 思考の折りたたみを全部開いておくか。localStorage に残る。思考のある行が1つも無ければトグルは出さない
  const [thinkingUi, setThinkingUi] = useLocalState<{ open: boolean }>('sai.thinking', { open: false })
  const hasThinking = data?.rows.some((r) => Boolean(r.thinking?.trim())) ?? false

  // ↑ で呼び戻す履歴。行の user_text から作り、送った直後のまだ届いていない分を先頭に足す
  const history = useMemo(() => historyFrom(data?.rows ?? NO_ROWS, id, mine ? [mine.text] : []), [data?.rows, id, mine])

  const s = data?.session
  const blocked = s ? replyBlockedReason(s) : ''
  return (
    <section>
      <BackLink onOpenSidebar={onOpenSidebar} />
      {s && (
        <div className="chat-head">
          {/* bare clone だと repo は worktree 名なので、リポジトリ名（project）。worktree は右の branch で分かる */}
          <h1><span className="hash">#</span>{projectName(s.project) || s.repo}</h1>
          <span className="meta"><AgentChip agent={s.agent} /></span>
          {/* origin が分かるときだけ、そのリポジトリへのリンク（remote が無ければ何も出ない） */}
          <RepoLink project={s.project} remote={s.remote} />
          {/* 使ったモデルの表示だけ。返信で使うモデルを変えるのは入力欄（送信ボタンの左） */}
          {s.model && <span className="meta"><ModelTag model={s.model} models={s.models} /></span>}
          {s.branch && <span className="meta"><code>{s.branch}</code></span>}
          <span className="meta">{dayLabel(s.start)} {hm(s.start)} – {hm(s.end)} · {s.turns} ターン</span>
          <span className="meta" title={s.id}>
            {s.session_source === 'synth' ? <SynthTag /> : <span className="tag">{s.session_source}</span>}
            {s.terminal && <TerminalTag terminal={s.terminal} />}
            {s.waiting && <WaitingTag text={s.waiting} />}
            {approvals.length > 0 && <WaitingTag text={approvals[0]!.text} />}
            {mine && <ReplyingTag since={mine.since} now={now} />}
            {s.archived && <ArchivedTag />}
            {/* 通常のモードは印を出さない（普段と違うときだけ目立たせる） */}
            {s.permission_mode && s.permission_mode !== 'default' && <PermissionModeTag mode={s.permission_mode} />}
          </span>
          {/* 合成 ID は集計の切れ方で付け先がずれるのでアーカイブできない */}
          {s.session_source !== 'synth' && <ArchiveButton key={`${s.id}:${s.archived ? 1 : 0}`} id={s.id} archived={Boolean(s.archived)} />}
          <MetaEditor key={s.id} id={s.id} meta={s.meta} icon={s.icon} />
          <DiffButton onOpen={() => onOpenDiff(s.id)} />
          {s.agent === 'claude' && <PermissionsButton key={s.id} id={s.id} />}
          {/* SAI から返信するときの許可モード。端末に打ち込む経路では効かないので、そのときは薄く出す */}
          {s.agent === 'claude' && <SessionPermissionModeSelect key={s.id} id={s.id} value={s.meta?.permission_mode} terminal={Boolean(s.terminal)} />}
          {/* 一言が有効なときだけ。このセッションの性格（無ければヘッダの既定に従う） */}
          {settings?.digest && <SessionPersonaSelect key={s.id} id={s.id} value={s.meta?.persona} defaultPersona={settings.persona} />}
          {hasThinking && (
            <span className="meta">
              <button type="button" className="linkish" onClick={() => setThinkingUi({ open: !thinkingUi.open })} title="エージェントの思考（thinking）の折りたたみを全部開く／閉じる">
                {thinkingUi.open ? '思考を全部閉じる' : '思考を全部開く'}
              </button>
            </span>
          )}
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
          trailer={
            <>
              {mine && <PendingBubble text={mine.text} since={mine.since} now={now} quiet={promptArrived(data.rows, id, mine.text, mine.since)} profile={data.profile} />}
              {approvals.map((a, i) => <ApprovalBubble key={a.approval_id} approval={a} now={now} hotkey={i === 0} />)}
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
            onSend={async (text, attachments) => (await send(id, text, { attachments })) !== 'confirm'}
          />
        ))}
      {confirmHere && <ReplaceConfirm confirm={confirmHere} onReplace={() => void confirmReplace()} onProcess={() => void confirmProcess()} onCancel={cancelConfirm} />}
      {failedHere && <div className="notice error">送信失敗: {failedHere}</div>}
    </section>
  )
}
