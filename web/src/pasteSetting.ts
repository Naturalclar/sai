import { createContext } from 'react'

/**
 * 長い貼り付けをファイルにして添えるか（#609。設定の `paste_to_file`。既定は切）。
 * 入力欄（`ReplyBox`）はセッション画面・フィード・要対応の 3 か所から使うので、`App` が 1 か所で渡す
 */
export const PasteToFileContext = createContext(false)
