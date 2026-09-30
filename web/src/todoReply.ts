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
