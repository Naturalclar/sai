// ログインのパネル（#577）を開いているかを、バナーが描き直されてもまたいで覚える。
// バナーは一覧の `claude_logged_out` が立っている間だけ描かれ、絞り込みを変えたときなどに一瞬消える。
// そこで開いていたことを忘れると、コードを貼る欄が消えて手順をやり直すことになる（サーバの子は生きたまま）。
// **覚えるのは手順の時間切れ（10 分）まで**: 古い印が残って、次に切れたとき勝手にログインを始めないように

import { CLAUDE_LOGIN_TIMEOUT_MS } from '../../shared/claudeLogin.ts'

/** サーバが子を落とすまでと同じ長さ */
export const LOGIN_PANEL_REMEMBER_MS = CLAUDE_LOGIN_TIMEOUT_MS

let openedAt = 0

/** 開いたままにするか */
export function loginPanelOpen(now: number): boolean {
  return openedAt > 0 && now - openedAt < LOGIN_PANEL_REMEMBER_MS
}

/** 開いた・閉じた（やめた・ログインできた）を覚える */
export function rememberLoginPanel(open: boolean, now: number): void {
  openedAt = open ? now : 0
}
