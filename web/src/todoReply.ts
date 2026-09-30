// 要対応の行から次の指示を送る（#522）の画面側の判定。DOM に依らないので node:test で回す（todoReply.test.ts）
import type { TodoItem } from '../../shared/todoItems.ts'

/**
 * その行に返信欄を出せるか。答え待ち（`answer`）は行の中のボタンで答えるので出さない。
 * `watch` / `done` は `replyable`（別のマシン・合成 ID・OpenCode の許可待ちなどは false）で決め、行にセッションが要る
 */
export function rowReplyable(t: Pick<TodoItem, 'kind' | 'replyable' | 'session'>): boolean {
  return t.kind !== 'answer' && t.replyable && t.session !== null
}

/**
 * いま開いておく行。**開いていた行が並びから消えた**（送って処理中になった・端末で片付いた）ら閉じる。
 * 消えたまま開いた印を残すと、ターンが終わって行が戻ってきたときに勝手に開いてしまう
 */
export function openRow(openId: string | null, items: readonly Pick<TodoItem, 'id' | 'kind' | 'replyable' | 'session'>[]): string | null {
  if (!openId) return null
  return items.some((t) => t.id === openId && rowReplyable(t)) ? openId : null
}

/**
 * `useReply` に渡す「処理中の返信」を、**この画面から送ったセッションのぶんだけ**にする（#528 のレビュー）。
 * サーバの `replying` は全セッションのぶんで、そのまま渡すと、セッション画面・フィード・MCP・預かりから送った返信の
 * 失敗まで拾って要対応に「送信失敗」を出してしまう（要対応は `replying[].failed` を出さない画面）。
 * また行数（`turns`）は絞り込み後の一覧からしか数えられないので、一覧に居ないセッションの返信は
 * 終わっても行数が増えず「記録が増えなかった」と誤って出る
 */
export function ownReplying<T>(replying: Readonly<Record<string, T>>, sentFrom: ReadonlySet<string>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const id of sentFrom) if (replying[id] !== undefined) out[id] = replying[id]
  return out
}
