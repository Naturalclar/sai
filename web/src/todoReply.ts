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
 * 何もしなければ返信欄を開いておくか。**終わって次を待っている行（`done`）は最初から開く**（すぐ次を打てるように）。
 * 待機中（`watch`）は答えを待っている段で、下段より数が少なく中身も長いので、押したときだけ開く
 */
export function opensByDefault(t: Pick<TodoItem, 'kind'>): boolean {
  return t.kind === 'done'
}

/** 切り替えの鍵。区分を混ぜるので、待機中から終わった行に変わったら既定に戻る */
export function toggleKey(t: Pick<TodoItem, 'id' | 'kind'>): string {
  return `${t.kind}:${t.id}`
}

/** その行の返信欄が開いているか。`toggled` は人が既定から切り替えた行（開いた・閉じた）の鍵 */
export function rowOpen(t: Pick<TodoItem, 'id' | 'kind' | 'replyable' | 'session'>, toggled: ReadonlySet<string>): boolean {
  return rowReplyable(t) && opensByDefault(t) !== toggled.has(toggleKey(t))
}

/**
 * 並びから消えた行の切り替えを忘れる（送って処理中になった・端末で片付いた）。忘れないと、ターンが終わって行が
 * 戻ってきたときに前の開け閉めが残る。**何も消えなければ同じ Set を返す**（描画中に state を合わせるので、毎回新しくすると回り続ける）
 */
export function pruneToggled(toggled: ReadonlySet<string>, items: readonly Pick<TodoItem, 'id' | 'kind'>[]): ReadonlySet<string> {
  if (toggled.size === 0) return toggled
  const live = new Set(items.map(toggleKey))
  const kept = [...toggled].filter((k) => live.has(k))
  return kept.length === toggled.size ? toggled : new Set(kept)
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
