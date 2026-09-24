/**
 * チャットの最下部追従の判定（#344）。DOM に触らない部分だけをここに置く（`.tsx` は DOM が要るので node:test で回せない）。
 * 追従そのものは `Chat.tsx` が持ち、「いま最下部の近くか」と「最下部へ送るか」の 2 つだけを共有する。
 */

/** 最下部と見なす距離（px）。ここに入っている間は新しい行に追従する */
export const NEAR_BOTTOM_PX = 40

/** 最下部の近くにいるか（`onScroll` から呼ぶ） */
export function nearBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight < NEAR_BOTTOM_PX
}

/**
 * 最下部へ送るか。追従中で、かつ**中身の高さが前に送ったときから変わった**ときだけ。
 *
 * 高さで見るのは、描画の回数では見られないため（#344）。`usePolling` は `rev` が同じでも `updatedAt` のために
 * 3 秒ごとに state を更新し、`Chat` の `trailer` は毎描画で新しい要素なので追従の effect は毎回走る。
 * 「走ったら送る」にしていたころは、最下部から `NEAR_BOTTOM_PX` 以内にいる間、行が 1 つも増えていなくても
 * 3 秒ごとに最下部へ引き戻されて、直前の発言を読み返せなかった。
 */
export function followsBottom(stick: boolean, applied: number, height: number): boolean {
  return stick && height !== applied
}

/**
 * 先頭に前の行が足されたか（#477。「前の 7 日を表示」）。先頭の行の時刻がさかのぼったときだけ。
 * 最初の描画（前が空）と、先頭が消えた・同じときは足されていない
 */
export function prepended(prevFirstTs: string, firstTs: string): boolean {
  const prev = Date.parse(prevFirstTs)
  const next = Date.parse(firstTs)
  return !Number.isNaN(prev) && !Number.isNaN(next) && next < prev
}
