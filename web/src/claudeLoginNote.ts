// SAI からのログインの手順（#577）の、いまの状態を人に見せる文と、画面がどこまで出すか。描く側は `ClaudeLoginPanel`
import { CLAUDE_LOGIN_TIMEOUT_MS } from '../../shared/claudeLogin.ts'
import type { ClaudeLoginResponse } from '../../shared/types.ts'

/** 進んでいた手順が、この画面の外で止まった（別の画面でやめた・サーバを立て直した）ときの文 */
export const LOGIN_LOST_NOTE = 'ログインの手順が止まりました（別の画面でやめたか、サーバを立て直しました）。「もう一度始める」を押してください'

/** 手順が走っている（画面が状態を聞き続ける）か */
export function loginActive(state: ClaudeLoginResponse): boolean {
  return state.status === 'starting' || state.status === 'waiting' || state.status === 'sent' || state.status === 'checking'
}

/** コードの入力欄を出すか（URL が出ていて、子がコードを待っている間） */
export function loginAcceptsCode(state: ClaudeLoginResponse): boolean {
  return (state.status === 'waiting' || state.status === 'sent') && Boolean(state.url)
}

/** 状態の 1 行 */
export function loginNote(state: ClaudeLoginResponse): string {
  switch (state.status) {
    case 'idle':
      return ''
    case 'starting':
      return 'ログインのページを用意しています…'
    case 'waiting':
      return state.note === 'invalid_code' ? 'コードが違うようです。ページに出たコードを全部コピーして、もう一度貼ってください' : ''
    case 'sent':
      return 'コードを渡しました。確かめています…'
    case 'checking':
      return 'ログインできたか確かめています…'
    case 'done':
      return 'ログインできました（まもなく消えます）。失敗した返信は送り直してください'
    case 'failed':
      if (state.note === 'timeout') return `時間切れです（${Math.round(CLAUDE_LOGIN_TIMEOUT_MS / 60_000)} 分）。「もう一度始める」を押してください`
      if (state.note === 'no_url') return 'claude がログインのページを出しませんでした。Mac の端末で claude auth login を打ってください'
      if (state.note === 'spawn_failed') return 'claude を起動できませんでした（サーバを起動した環境の PATH に claude があるか確かめてください）'
      if (state.note === 'logged_in') return 'Claude はもうログインできています（ログインし直しません）。「確かめ直す」を押してください'
      if (state.note === 'unknown') return 'Claude のログインの状態が分からないので、ログインし直しません（claude が見つからない・応答が無い）'
      if (state.note === 'unavailable') return 'このサーバからはログインできません。Mac の端末で claude auth login を打ってください'
      return 'ログインできませんでした。もう一度試すか、Mac の端末で claude auth login を打ってください'
  }
}
