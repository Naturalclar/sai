// 差分ビューアで、最初から本文を開いておくファイルを決める（#221）。DOM に依存しないので diffOpen.test.ts で回す。
//
// 以前はファイル数（5 件以下なら開く）で決めていたが、実測ではこのリポジトリのブランチの差分は
// 11〜35 ファイルで、**読みたいほうが必ず全部閉じて出ていた**。数えるべきはファイル数ではなく
// 描画する行数なので、上から順に行数を積んで予算のぶんだけ開く。

/**
 * 最初から開いておく合計行数。1 行が `div.ln` + `span` 4 つ（≒5 要素）なので、4000 行 ≒ 2 万要素。
 *
 * 実測（稼働中のサーバの 6 セッション）ではセクションあたり 218〜1903 行（≒1,100〜9,500 要素）だったので、
 * 普段の差分は**全部開く**。効いてくるのはサーバ側の上限いっぱい（1 セクション 2MB ≒ 5 万行）に
 * 近いような差分だけで、そこで開ききるとタブが固まる
 */
export const AUTO_OPEN_LINES = 4000

/** 1 ファイルぶんの重さ。`lines` は描画する行数（文脈行を含む。numstat の増減だけではない） */
export interface DiffSize {
  path: string
  lines: number
}

/**
 * 最初から開いておくファイルのパス。**上から順に**行数を積み、予算を超えた時点でそこから先は閉じたままにする。
 * 予算を超えるファイルが 1 件目でも開かない（開いた瞬間に固まるのを防ぐのが予算の目的なので、
 * 1 件だけ特別扱いはしない）。閉じたぶんも押せば開く（人が選んだ分は予算を見ない）
 */
export function autoOpenPaths(files: readonly DiffSize[], budget = AUTO_OPEN_LINES): Set<string> {
  const open = new Set<string>()
  let used = 0
  for (const f of files) {
    if (used + f.lines > budget) break
    used += f.lines
    open.add(f.path)
  }
  return open
}
