import { useState } from 'react'
import { alwaysAllowRule, answerAsk, askQuestions, ruleLabel } from '../../shared/approvals.ts'
import { api, type Approval } from './api'
import { elapsedLabel, hm } from './format'

interface Props {
  approval: Approval
  /** 経過の基準（ポーリングの updatedAt） */
  now: number
  /** フィードではチャンネル名を添える */
  repo?: string
}

/**
 * 返信中のエージェントが待っている許可・質問。[許可] [常に許可] [拒否] で答える（常に許可は Bash と MCP ツールだけ）。
 * AskUserQuestion は選択肢をボタンで出し、全部の質問に答えたら送る。
 * 答えるとサーバの approvals から消え、次のポーリングでこのバブルも消える（送った直後は done で押せなくする）
 */
export function ApprovalBubble({ approval, now, repo }: Props) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<'allow' | 'always' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const questions = approval.tool_name === 'AskUserQuestion' ? askQuestions(approval.input) : []
  const elapsed = elapsedLabel(approval.since, now)

  // 「常に許可」で書かれるルール。無いツール（Edit や質問）にはボタンを出さない
  const always = questions.length === 0 ? alwaysAllowRule(approval.tool_name, approval.input) : null

  const send = async (body: Parameters<typeof api.answerApproval>[1]) => {
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
  }

  const detail = detailOf(approval)
  return (
    <div className={`group approval${done ? ' done' : ''}`}>
      <div className="avatar claude">C</div>
      <div>
        <div className="gh">
          <span className="name">Claude Code</span>
          {repo && <span className="ch">#{repo}</span>}
          <span className="time" title={`${hm(approval.since)} から待っている`}>{elapsed ? `待っている ${elapsed}` : '答えを待っている'}</span>
        </div>
        <div className="msg">
          <div className="body">⏳ {approval.text}</div>
          {detail && <pre className="detail">{detail}</pre>}
          {questions.length > 0 ? (
            <div className="questions">
              {questions.map((q) => (
                <div className="question" key={q.question}>
                  <div className="q">{q.header && <b>{q.header}: </b>}{q.question}</div>
                  <div className="options">
                    {q.options.map((o) => (
                      <button
                        type="button"
                        key={o.label}
                        className={answers[q.question] === o.label ? 'picked' : ''}
                        title={o.description}
                        disabled={busy || done !== null}
                        onClick={() => setAnswers((a) => ({ ...a, [q.question]: o.label }))}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <div className="actions">
                <button
                  type="button"
                  className="allow"
                  disabled={busy || done !== null || questions.some((q) => !answers[q.question])}
                  onClick={() => void send(answerAsk(approval, answers))}
                >
                  {done === 'allow' ? '答えた' : '答える'}
                </button>
                <button type="button" className="deny" disabled={busy || done !== null} onClick={() => void send({ behavior: 'deny', message: 'SAI の画面で答えなかった' })}>
                  {done === 'deny' ? '答えなかった' : '答えない'}
                </button>
              </div>
            </div>
          ) : (
            <div className="actions">
              <button type="button" className="allow" disabled={busy || done !== null} onClick={() => void send({ behavior: 'allow' })}>
                {done === 'allow' ? '許可した' : '許可'}
              </button>
              {always && (
                <button
                  type="button"
                  className="always"
                  disabled={busy || done !== null}
                  title={`${ruleLabel(always)} を返信先の .claude/settings.local.json に書く。以後この形は聞かれない（端末の「今後も許可」と同じ）`}
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
  if (a.tool_name === 'Bash' && typeof i.command === 'string' && (i.command.length > 80 || i.command.includes('\n'))) return i.command
  if ((a.tool_name === 'Write' || a.tool_name === 'Edit') && typeof i.file_path === 'string') {
    const body = typeof i.new_string === 'string' ? i.new_string : typeof i.content === 'string' ? i.content : ''
    return body ? `${i.file_path}\n---\n${body.split('\n').slice(0, 12).join('\n')}` : ''
  }
  return ''
}
