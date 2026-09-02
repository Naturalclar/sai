// 返信（= セッションを再開して1ターン回す）ができるかの判定。
// サーバの POST 受付（server/app.ts）と画面の入力欄の出し分け（web/src/SessionView.tsx）が同じ関数を使い、ずれない。
import type { SessionSummary } from './types.ts'

/** 返信できない理由。空文字なら返信できる */
export function replyBlockedReason(s: Pick<SessionSummary, 'id' | 'agent' | 'session_source'>): string {
  if (s.agent !== 'claude' && s.agent !== 'codex') return 'エージェントが不明なので再開できません'
  if (s.id.startsWith('unknown-')) return 'このセッションは再開できません（セッションIDが取れていない）'
  if (s.session_source === 'synth') return 'このセッションは再開できません（IDが合成）'
  if (s.session_source !== 'payload' && s.session_source !== 'rollout') return 'このセッションは再開できません（IDの出どころが不明）'
  return ''
}
