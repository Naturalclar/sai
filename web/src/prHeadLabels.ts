// PR の画面の題名の行に置く 2 つのボタン（#646）の文言と、差分の上に残す下書きの案内。DOM に触らない純粋関数（prHeadLabels.test.ts）

export interface HeadLabel {
  /** 広い画面の文言 */
  full: string
  /** 狭い画面の文言（題名の行が折り返さないように短くする） */
  short: string
}

/** 下書きの数。行コメントの件数に、全体のコメントがあれば 1 を足す */
export function draftCount(count: number, hasBody: boolean): number {
  return Math.max(0, count) + (hasBody ? 1 : 0)
}

/** 数は下書きがあるときだけ添える（0 件でもボタンは出したままなので、0 は書かない） */
function withCount(label: string, n: number): string {
  return n > 0 ? `${label} ${n}` : label
}

/** 「Submit review」（GitHub の Files changed のボタンと同じ文言。#649）。押すと確認の画面を開くだけ（#526） */
export function reviewLabel(count: number, hasBody: boolean): HeadLabel {
  const n = draftCount(count, hasBody)
  return { full: withCount('Submit review', n), short: withCount('レビュー', n) }
}

/** 書いたセッションの入力欄に入れる（#525）。全体のコメントは入力欄には入れないので、数えるのは行コメントだけ */
export function insertLabel(count: number, target: string): HeadLabel {
  const n = Math.max(0, count)
  return { full: withCount(target ? `「${target}」の入力欄に入れる` : '入力欄に入れる', n), short: withCount('入力欄へ', n) }
}

/** 差分の上に出す下書きの中身。何も無ければ空（案内の文を出す） */
export function draftSummary(count: number, hasBody: boolean): string {
  const parts = [...(count > 0 ? [`行コメント ${count} 件`] : []), ...(hasBody ? ['全体のコメント'] : [])]
  return parts.length ? `下書き: ${parts.join('・')}` : ''
}
