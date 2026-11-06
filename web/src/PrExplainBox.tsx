import { useState } from 'react'
import { api, type PrDetailResponse, type PrExplain } from './api'
import { sessionHash } from './hooks'
import { agoLabel } from './prLabels'
import { explainButtonLabel, explainHref, explainNote } from './prExplainLabels'

/**
 * PR の解説（#881）。押したときだけ利用者のスキル `/brief-pr` を SAI の新しいセッションとして回し、できた HTML を開くリンクを出す。
 *
 * - 途中経過・許可・失敗は回したセッションと要対応に出る（欄にそのセッションへのリンクを出す）。状態は「更新」で PR を読み直したときに変わる
 * - 開く先は SAI の口（`/api/pr-explain/<鍵>`）なので、tailnet 越しの画面からも開ける。サーバは `CSP: sandbox` で配る
 */
export function PrExplainBox({ repo, number, data, now }: { repo: string; number: number; data: PrDetailResponse; now: number }) {
  // この画面で押した・見に行った結果。PR を読み直したら（data が変わったら）そちらを使う
  const [mine, setMine] = useState<{ explain: PrExplain; data: PrDetailResponse } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const explain = mine && mine.data === data ? mine.explain : (data.explain ?? null)
  const running = explain?.state === 'running'
  if (!data.explain_available && !explain) return null
  const label = data.explain_available ? explainButtonLabel(explain) : ''
  const note = explainNote(explain)
  const make = () => {
    setBusy(true)
    setError('')
    api.makePrExplain(repo, number).then(
      (r) => {
        setMine({ explain: r.explain, data })
        setBusy(false)
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      },
    )
  }
  return (
    <div className="pr-explain">
      <span className="title">解説</span>
      {explain?.state === 'ready' && explain.key && (
        <a className="open" href={explainHref(explain.key)} target="_blank" rel="noopener noreferrer">
          解説を開く
        </a>
      )}
      {label && (
        <button type="button" disabled={busy} onClick={make}>
          {busy ? '始めています…' : label}
        </button>
      )}
      {running && <span className="busy">作っています…</span>}
      {explain && (
        <a className="session" href={sessionHash(explain.session)}>
          {agoLabel(explain.at, now)}に回したセッション
        </a>
      )}
      {note && <div className="note">{note}</div>}
      {error && <div className="warn">{error}</div>}
      {!explain && label && <div className="note">押すと、この PR の URL で /brief-pr を新しいセッションで回します（読むだけ。GitHub には書きません）</div>}
    </div>
  )
}
