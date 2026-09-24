// アイコンの履歴（#465）の画面側の判定。DOM に依らないので node:test で回す（iconHistory.test.ts）

/**
 * 消すボタンの 2 段目。1 回目で「消す？」に変え、同じものをもう一度押したら消す（押し間違えで消さない）。
 * 別のものを押したら、そちらの 1 回目になる。返すのは次の「確かめ中の鍵」と「いま消すか」
 */
export function nextRemoval(confirming: string | null, pressed: string): { confirming: string | null; remove: boolean } {
  if (confirming === pressed) return { confirming: null, remove: true }
  return { confirming: pressed, remove: false }
}
