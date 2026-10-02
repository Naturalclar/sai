// 差分のファイルの見出しを上に貼り付ける（#644）ときの、畳んだあとのスクロール位置。DOM に依らないので diffSticky.test.ts で回す。

/**
 * 貼り付いた見出しから畳むときに、スクロールを動かす量（px。負 = 上へ）。
 * `itemTop` はそのファイルの箱（`li`）の上端、`viewTop` はスクロール容器の見えている上端（どちらも画面の座標）。
 * 箱の上端が見えている範囲より上にある = 見出しが貼り付いているときだけ、箱の先頭まで戻す
 * （戻さないと、畳んで縮んだぶん下のファイルの途中に飛ぶ）。見出しが元の位置にあるときは動かさない
 */
export function collapseScrollBy(itemTop: number, viewTop: number): number {
  const d = Math.round(itemTop - viewTop)
  return d < 0 ? d : 0
}
