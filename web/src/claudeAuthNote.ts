// Claude のログインのバナー（#685）の「確かめ直す」の結果の文。描く側は `ClaudeAuthBanner`

export type AuthCheck = { kind: 'idle' } | { kind: 'asking' } | { kind: 'done'; loggedIn: boolean | null } | { kind: 'error'; message: string }

/** ボタンの横に出す 1 行。出すものが無ければ空 */
export function authCheckNote(check: AuthCheck): string {
  if (check.kind === 'asking') return '確かめています…'
  if (check.kind === 'error') return `確かめられませんでした: ${check.message}`
  if (check.kind !== 'done') return ''
  if (check.loggedIn === true) return 'ログインできています（まもなく消えます）'
  if (check.loggedIn === false) return 'まだ切れています'
  return '分かりませんでした（claude が見つからない・応答が無い）'
}
