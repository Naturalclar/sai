import { createContext } from 'react'

/**
 * 返信の既定の許可モード（#582。設定の `reply_mode`。空は「決めない」= CLI の既定）。
 * セッションのメタに許可モードが無いときだけ使う（`shared/permissions.ts` の `replyModeOf()`）。
 * 入力欄のボタン・「次の返信から」の一言・新しいセッションの画面が読むので、`App` が 1 か所で渡す
 */
export const DefaultReplyModeContext = createContext('')
