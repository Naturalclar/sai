import type { SendCost } from '../../shared/compact.ts'

/**
 * 入力欄の下に出す、送る前の大きさと間（#761）。キャッシュが切れている見込みなら印を付ける。
 * 文は `shared/compact.ts` の `sendCost()` が作る（ここは置くだけ）
 */
export function ReplySendCost({ cost }: { cost: SendCost }) {
  return (
    <div className={`send-cost${cost.cold ? ' cold' : ''}`} title={cost.title}>
      {cost.text}
      {cost.cold && <span className="mark">キャッシュ切れの見込み</span>}
    </div>
  )
}
