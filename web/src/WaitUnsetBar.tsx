import { useState } from 'react'
import { api } from './api'

interface Props {
  /** このセッションのエンティティID */
  id: string
  /** そのセッションのブランチから出ている open な PR（サーバが引いたもの） */
  pr: number
  /** 置けない理由（素通し・端末で開いている…）。あれば口は押せない */
  blocked?: string | undefined
}

/**
 * 「待ちます」と言って終わったのに、待ち（`sai_wait_for`）が預けられていないセッションの知らせと、人が待ちを置く口（#732 の案 3）。
 * 押すと、サーバがそのセッションのブランチの PR を引き直して「CI が終わったら 1 回起こす」を置く（番号は画面から送らない）。
 * 置けないセッション（許可を聞かないモードなど）では、理由を出して押せなくする
 */
export function WaitUnsetBar({ id, pr, blocked }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 置けたあとは押せなくする（次のポーリングで帯ごと消えるまでの間に、もう 1 回押させない）
  const [placed, setPlaced] = useState(false)
  const add = async () => {
    setBusy(true)
    setError('')
    try {
      await api.waitAdd(id)
      setPlaced(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="agent-activity loop-bar wait-bar wait-unset">
      <div className="head">
        <span className="title">「待ちます」と言って終わりましたが、起こす予定がありません</span>
        <span className="actions">
          <button
            type="button"
            disabled={busy || placed || Boolean(blocked)}
            onClick={() => void add()}
            title={blocked ? blocked : `PR #${pr} の CI が終わったら、このセッションを 1 回起こす（結果を読んで報告させる。マージはしない。起こすと文脈を読み直すのでトークンを使う）`}
          >
            PR #{pr} の CI を待つ
          </button>
        </span>
      </div>
      {blocked && <div className="note">置けません: {blocked}</div>}
      {error && <div className="err">{error}</div>}
    </div>
  )
}
