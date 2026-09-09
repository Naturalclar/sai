import { useCallback, useEffect, useState } from 'react'
import { alwaysAllowRule, answerAsk, askQuestions, ruleLabel } from '../../shared/approvals.ts'
import { approvalAction } from './approvalKeys'
import { api, type Approval } from './api'
import { AskQuestions } from './AskQuestions'
import { elapsedLabel, hm } from './format'

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
}

/**
 * エージェントが待っている許可・質問。[許可] [常に許可] [拒否] で答える（常に許可は Bash と MCP ツールだけ）。
 * AskUserQuestion は AskQuestions が 1 問ずつ出し、全部そろったら送る。
 * 通常起動の Codex TUI は待機を検出できても安全な回答経路が無いので、端末で答える案内だけを出す。
 * 答えるとサーバの approvals から消え、次のポーリングでこのバブルも消える（送った直後は done で押せなくする）
 */
export function ApprovalBubble({ approval, now, repo, hotkey = false }: Props) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<'allow' | 'always' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const questions = approval.tool_name === 'AskUserQuestion' ? askQuestions(approval.input) : []
  const elapsed = elapsedLabel(approval.since, now)
  const agent = approval.agent ?? 'claude'
  const answerable = approval.answerable !== false

  // 「常に許可」で書かれるルール。無いツール（Edit や質問）にはボタンを出さない
  const always = agent === 'claude' && questions.length === 0 ? alwaysAllowRule(approval.tool_name, approval.input) : null
  const decisions = approval.decisions ?? []

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
      e.preventDefault()
      e.stopPropagation()
      void send(action === 'always' ? { behavior: 'allow', remember: 'local' } : { behavior: 'allow' })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [armed, hasAlways, send])

  const detail = detailOf(approval)
  return (
    <div className={`group approval${done ? ' done' : ''}`}>
      <div className={`avatar ${agent}`}>{agent === 'codex' ? 'X' : 'C'}</div>
      <div>
        <div className="gh">
          <span className="name">{agent === 'codex' ? 'Codex CLI' : 'Claude Code'}</span>
          {repo && <span className="ch">#{repo}</span>}
          <span className="time" title={`${hm(approval.since)} から待っている`}>{elapsed ? `待っている ${elapsed}` : '答えを待っている'}</span>
        </div>
        <div className="msg">
          <div className="body">⏳ {approval.text}</div>
          {detail && <pre className="detail">{detail}</pre>}
          {!answerable ? (
            <div className="notice">このCodexは端末で起動されているため、回答はtmuxの画面で行ってください。</div>
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
                  className={decision.behavior === 'allow' ? 'allow' : 'deny'}
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
                  className="always"
                  disabled={busy || done !== null}
                  title={`${ruleLabel(always)} を返信先の .claude/settings.local.json に書く。以後この形は聞かれない（端末の「今後も許可」と同じ）${armed ? '。⌘⇧Enter / Ctrl+⇧Enter' : ''}`}
                  onClick={() => void send({ behavior: 'allow', remember: 'local' })}
                >
                  {done === 'always' ? `常に許可した（${ruleLabel(always)}）` : '常に許可'}
                </button>
              )}
              <button type="button" className="deny" disabled={busy || done !== null} onClick={() => void send({ behavior: 'deny' })}>
                {done === 'deny' ? '拒否した' : '拒否'}
              </button>
            </div>
          )}
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
