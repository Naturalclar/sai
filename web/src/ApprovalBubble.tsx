import { useCallback, useEffect, useState } from 'react'
import { answerAsk, askQuestions } from '../../shared/approvals.ts'
import { countNote, rulesKey } from '../../shared/approvalCounts.ts'
import { AlwaysRules } from './AlwaysRules'
import { approvalAction, hotkeyApplies, REPLY_FOR_ATTR } from './approvalKeys'
import { decisionClass } from './approvalDecisionClass'
import { api, type Approval } from './api'
import { AskQuestions } from './AskQuestions'
import { DialogPreview } from './DialogPreview'
import { JevTag } from './JevTag'
import { elapsedLabel, hm } from './format'
import { AGENT_INITIAL, AGENT_LABEL } from './chatGroups.ts'
import { Avatar } from './Avatar'

interface Props {
  approval: Approval
  /** 経過の基準（ポーリングの updatedAt） */
  now: number
  /** フィードではチャンネル名を添える */
  repo?: string
  /**
   * このバブルがキーボードショートカットの対象か。複数出るフィードでは**一番上の 1 つ**だけ true にする。
   * 決めるのは親（FeedView / SessionView）で、描画順の先頭
   */
  hotkey?: boolean
  /**
   * 処理中のターンが今の設定と違う許可モードで動いているときの一言（`launchedModeNote()`。#272）。
   * 「素通しにしたのに聞かれる」の理由がこれなので、バブルに添える。無ければ空
   */
  modeNote?: string
  /**
   * そのセッションのアイコン（#666。`SessionSummary.icon`）。あれば頭文字の代わりに出す。
   * 記録に 1 行も無いセッション（端末の Codex のダイアログ。#417）はアイコンが無いので頭文字のまま
   */
  icon?: string | undefined
}

/**
 * エージェントが待っている許可・質問。[許可] [常に許可] [拒否] で答える（常に許可は Bash と MCP ツールだけ）。
 * AskUserQuestion は AskQuestions が 1 問ずつ出し、全部そろったら送る。
 * 通常起動の Codex TUI は待機を検出できても安全な回答経路が無いので、端末で答える案内だけを出す。
 * 答えるとサーバの approvals から消え、次のポーリングでこのバブルも消える（送った直後は done で押せなくする）
 */
export function ApprovalBubble({ approval, now, repo, hotkey = false, modeNote = '', icon }: Props) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<'allow' | 'always' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const questions = approval.tool_name === 'AskUserQuestion' ? askQuestions(approval.input) : []
  const elapsed = elapsedLabel(approval.since, now)
  const agent = approval.agent ?? 'claude'
  const answerable = approval.answerable !== false

  // 「常に許可」で書かれるルール（#705。サーバが組む。つないだコマンドは部品ごと）。無いツール・コマンドにはボタンを出さない
  const always = agent === 'claude' && questions.length === 0 && approval.always?.length ? approval.always : null
  const decisions = approval.decisions ?? []
  // 同じルールの組の何回目か（#445）。決めた回数からは「常に許可」を勧める（押すのは人）
  const counted = always ? countNote(approval, rulesKey(always)) : ''
  const suggest = !!always && !!approval.suggest

  const send = useCallback(
    async (body: Parameters<typeof api.answerApproval>[1]) => {
      setBusy(true)
      setError(null)
      try {
        await api.answerApproval(approval.approval_id, body)
        setDone(body.remember ? 'always' : body.behavior)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [approval.approval_id],
  )

  // ⌘Enter で許可、⌘⇧Enter で常に許可。答えるだけの質問（AskUserQuestion）と、処理中・答え済みのバブルは受けない。
  // **capture** で張るので、入力欄（ReplyBox）が ⌘Enter を「送信」として扱うより先に来る。
  // 拾ったときだけ stopPropagation するので、答え待ちのバブルが無ければ入力欄の ⌘Enter は今までどおり
  const hasAlways = always !== null
  const armed = agent === 'claude' && answerable && hotkey && !busy && done === null && questions.length === 0
  useEffect(() => {
    if (!armed) return
    const onKeyDown = (e: KeyboardEvent) => {
      const action = approvalAction(e, hasAlways)
      if (!action) return
      // 別のセッションの返信欄で押された ⌘Enter は、その返信欄の送信に任せる（要対応の行の下の返信欄）
      const owner = e.target instanceof Element ? e.target.closest(`[${REPLY_FOR_ATTR}]`) : null
      // モーダルの中・フォーカスの無いペインの中で押されたものは受けない（#633）
      const pane = e.target instanceof Element ? e.target.closest('.pane') : null
      const elsewhere = (e.target instanceof Element && e.target.closest('[role="dialog"]') !== null) || (pane !== null && !pane.classList.contains('focused'))
      if (!hotkeyApplies(owner?.getAttribute(REPLY_FOR_ATTR) ?? null, approval.id, elsewhere)) return
      e.preventDefault()
      e.stopPropagation()
      void send(action === 'always' ? { behavior: 'allow', remember: 'local' } : { behavior: 'allow' })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [armed, hasAlways, send, approval.id])

  const detail = detailOf(approval)
  return (
    <div className={`group approval${done ? ' done' : ''}`}>
      <Avatar kind={agent} icon={icon} mark={AGENT_INITIAL[agent] ?? 'C'} />
      <div>
        <div className="gh">
          <span className="name">{AGENT_LABEL[agent] ?? 'Claude Code'}</span>
          {repo && <span className="ch">#{repo}</span>}
          <span className="time" title={`${hm(approval.since)} から待っている`}>{elapsed ? `待っている ${elapsed}` : '答えを待っている'}</span>
        </div>
        <div className="msg">
          <div className="body">⏳ {approval.text}</div>
          {/* 許可して問題なさそうかの予想（#491）。押すのは人。自動で答えるかは設定の閾値（#499。答えたバブルはここに出ない） */}
          {approval.jev !== undefined && <JevTag safe={approval.jev} rule={approval.jev_rule} />}
          {detail && <pre className="detail">{detail}</pre>}
          {counted && <div className={`count-note${suggest ? ' suggest' : ''}`}>{counted}</div>}
          {/* 端末の画面から読んだ選択肢（#425）。下のボタンで答えられる（#450） */}
          {approval.dialog && <DialogPreview dialog={approval.dialog} />}
          {/* 素通しに変えても、処理中のターンは起動したときのモードのまま聞いてくる（#272）。質問は素通しでも出るので付けない */}
          {modeNote && questions.length === 0 && <div className="mode-note">{modeNote}</div>}
          {!answerable ? (
            <div className="notice">
              {/* 端末のダイアログ（`dialog` がある）か、SAI が回している app-server の許可か（#741）で、答える場所が違う */}
              {approval.dialog || !approval.tool_name.startsWith('Codex')
                ? 'このCodexのダイアログは画面から読めませんでした。回答はtmuxの画面で行ってください。'
                : 'Codex が出した選択肢を、画面に書ける形で読めませんでした。ここからは答えられません。続けない場合は「止める」でターンを止めてください。'}
            </div>
          ) : questions.length > 0 ? (
            <AskQuestions
              questions={questions}
              busy={busy}
              done={done !== null}
              onAnswer={(answers) => void send(answerAsk(approval, answers))}
              onDecline={() => void send({ behavior: 'deny', message: 'SAI の画面で答えなかった' })}
            />
          ) : decisions.length > 0 ? (
            <div className="actions">
              {decisions.map((decision) => (
                <button
                  type="button"
                  key={decision.id}
                  // 残る候補（#741 の「今後聞かない」「今後も断る」）は、今回だけのボタンと同じ見た目にしない
                  className={decisionClass(decision)}
                  disabled={busy || done !== null}
                  onClick={() => void send({ behavior: decision.behavior, decision: decision.id })}
                >
                  {decision.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="actions">
              <button
                type="button"
                className="allow"
                disabled={busy || done !== null}
                title={armed ? '許可（⌘Enter / Ctrl+Enter）' : '許可'}
                onClick={() => void send({ behavior: 'allow' })}
              >
                {done === 'allow' ? '許可した' : '許可'}
              </button>
              {always && (
                <button
                  type="button"
                  className={`always${suggest ? ' suggest' : ''}`}
                  disabled={busy || done !== null}
                  title={`${rulesKey(always)} を返信先の .claude/settings.local.json に書く。以後、下に並んだルールの範囲は聞かれない（端末の「今後も許可」と同じ）${armed ? '。⌘⇧Enter / Ctrl+⇧Enter' : ''}`}
                  onClick={() => void send({ behavior: 'allow', remember: 'local' })}
                >
                  {done === 'always' ? '常に許可した' : '常に許可'}
                </button>
              )}
              <button type="button" className="deny" disabled={busy || done !== null} onClick={() => void send({ behavior: 'deny' })}>
                {done === 'deny' ? '拒否した' : '拒否'}
              </button>
            </div>
          )}
          {/* [常に許可] で何を許可することになるか（#705）。部品ごとに書くので、押す前に全部見せる */}
          {always && answerable && decisions.length === 0 && <AlwaysRules rules={always} done={done === 'always'} />}
          {/* 拒否すると Codex は「どうしてほしいか」を聞いてくるので、そのまま入力欄へ（#450） */}
          {done === 'deny' && approval.dialog && <div className="notice">拒否しました。どうしてほしいかは、下の返信欄から送れます。</div>}
          {error && <div className="empty-text">送れなかった: {error}</div>}
        </div>
      </div>
    </div>
  )
}

/** text（1行の要約）に入り切らない中身。Bash はコマンド全文、Edit/Write は差し込む内容の先頭 */
function detailOf(a: Approval): string {
  const i = a.input
  if (a.tool_name === 'CodexCommand') {
    const command = typeof i.command === 'string' ? i.command : ''
    const cwd = typeof i.cwd === 'string' ? i.cwd : ''
    const reason = typeof i.reason === 'string' ? i.reason : ''
    const permissionDetails = Object.fromEntries([
      ['追加権限', i.additionalPermissions],
      ['ネットワーク', i.networkApprovalContext],
      ['実行規則の提案', i.proposedExecpolicyAmendment],
      ['ネットワーク規則の提案', i.proposedNetworkPolicyAmendments],
    ].filter((entry) => entry[1] !== undefined && entry[1] !== null))
    const permissions = Object.keys(permissionDetails).length ? JSON.stringify(permissionDetails, null, 2) : ''
    return [command, cwd && `cwd: ${cwd}`, reason && `理由: ${reason}`, permissions].filter(Boolean).join('\n')
  }
  if (a.tool_name === 'CodexFileChange') {
    const changes = Array.isArray(i.changes) ? i.changes : []
    const bodies = changes.flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return []
      const change = raw as Record<string, unknown>
      const path = typeof change.path === 'string' ? change.path : ''
      const diff = typeof change.diff === 'string' ? change.diff : ''
      return path || diff ? [`${path}${diff ? `\n${diff}` : ''}`] : []
    })
    const reason = typeof i.reason === 'string' ? `理由: ${i.reason}` : ''
    return [bodies.join('\n\n') || (typeof i.grantRoot === 'string' ? i.grantRoot : ''), reason].filter(Boolean).join('\n')
  }
  if (a.tool_name === 'CodexPermissions') {
    return JSON.stringify(i.permissions ?? {}, null, 2)
  }
  if (a.tool_name === 'Bash' && typeof i.command === 'string' && (i.command.length > 80 || i.command.includes('\n'))) return i.command
  if ((a.tool_name === 'Write' || a.tool_name === 'Edit') && typeof i.file_path === 'string') {
    const body = typeof i.new_string === 'string' ? i.new_string : typeof i.content === 'string' ? i.content : ''
    return body ? `${i.file_path}\n---\n${body.split('\n').slice(0, 12).join('\n')}` : ''
  }
  return ''
}
