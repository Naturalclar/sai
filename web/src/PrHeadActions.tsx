import { insertLabel, reviewLabel } from './prHeadLabels'

/**
 * PR の画面の題名の行に置く「入力欄に入れる」（#525）と「GitHub にレビューを投稿…」（#526）。題名の行は流れないので、
 * 差分のどこを読んでいても押せる（#646。前は差分の上にあり、読み終わると一番上まで戻らないと押せなかった）。
 * **その PR の既定の方を主のボタン、もう片方を小さいリンクにする**（書いたセッションが見つかる PR は入力欄に入れる方が主）。
 * 投稿は押すと確認の画面を開くだけで、ここからは送らない。狭い画面では文言を短くする（CSS が `.full` / `.short` を切り替える）
 */
export function PrHeadActions({
  count,
  hasBody,
  target,
  onInsert,
  onReview,
}: {
  count: number
  hasBody: boolean
  /** 入れる先のセッションの名前 */
  target: string
  /** 無ければ「入力欄に入れる」を出さない（書いたセッションが見つからない・返信できない） */
  onInsert?: (() => void) | undefined
  /** 無ければ投稿を出さない（`gh` が使えない・PR が open でない） */
  onReview?: (() => void) | undefined
}) {
  const insert = insertLabel(count, target)
  const review = reviewLabel(count, hasBody)
  return (
    <>
      {onReview && (
        <button type="button" className={`head-act ${onInsert ? 'linkish' : 'primary'}`} onClick={onReview} title="確認の画面を開く（押すまで GitHub には送らない）" aria-label={review.full}>
          <span className="full">{review.full}</span>
          <span className="short">{review.short}</span>
        </button>
      )}
      {onInsert && (
        <button
          type="button"
          className="head-act primary"
          onClick={onInsert}
          disabled={count === 0}
          title={count === 0 ? '行番号を押してコメントを書くと、まとめて入力欄に入れられます' : `${insert.full}（送りはしない）`}
          aria-label={insert.full}
        >
          <span className="full">{insert.full}</span>
          <span className="short">{insert.short}</span>
        </button>
      )}
    </>
  )
}
