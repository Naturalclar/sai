// 預かっている返信（#305）の画面側の判定と文言。DOM に依らないので node:test で回す（replyQueue.test.ts）

/**
 * 続きの返信を預けるか。前の返信を処理中か、預かりが残っているとき。
 * 残っているときも預けるのは、先に預けたものを追い越して起動しないため（止めている間も同じ）。
 * 端末（tmux）で開いているセッションでも付けてよい（サーバは `-p` のターンが動いていなければ預からずに打ち込む）
 */
export function shouldQueue(busy: boolean, queued: number): boolean {
  return busy || queued > 0
}

/** バブルの見出し。`待機中（2 番目） · 3分`。経過が出せなければ付けない */
export function queuedLabel(order: number, elapsed: string): string {
  return `待機中（${order} 番目）${elapsed ? ` · ${elapsed}` : ''}`
}
