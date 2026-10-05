import { useState } from 'react'
import { api } from './api'
import type { TurnStepsResponse } from './api'
import { stepCounts } from '../../shared/turnSteps.ts'
import { hm } from './format'
import { Markdown } from './Markdown'

type State = { kind: 'closed' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'open'; data: TurnStepsResponse }

/**
 * 終わったターンで実行したコマンド・ツールと、途中で書いた文（#605 / #680）。返答のバブルに畳んで付け、**開いたときに 1 回だけ**取る
 * （ポーリングには乗せない。数と種類は取ってからでないと分からないので、畳んでいる間は「手順」とだけ出す）。
 * 出すのはツール名とコマンド・ファイル名まで。出力は出さない。引けなければ「記録がありません」
 */
export function TurnSteps({ id, ts }: { id: string; ts: string }) {
  const [state, setState] = useState<State>({ kind: 'closed' })
  const [shown, setShown] = useState(false)
  const toggle = () => {
    if (shown) return setShown(false)
    setShown(true)
    if (state.kind === 'open' || state.kind === 'loading') return
    setState({ kind: 'loading' })
    api
      .turnSteps(id, ts)
      .then((data) => setState({ kind: 'open', data }))
      .catch((err: unknown) => setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }))
  }
  const data = state.kind === 'open' ? state.data : null
  return (
    <div className="turn-steps">
      <button type="button" className="linkish" aria-expanded={shown} onClick={toggle} title="このターンで実行したコマンド・ツールを見る（出力は出しません）">
        {shown ? '手順を閉じる' : '手順'}
        {data?.found && data.total > 0 && <span className="counts"> {data.total} 件（{stepCounts(data.steps)}）</span>}
      </button>
      {shown && state.kind === 'loading' && <div className="note">読み込み中…</div>}
      {shown && state.kind === 'error' && <div className="note err">{state.message}</div>}
      {shown && data && !data.found && <div className="note">記録がありません（transcript が無い・要約で消えた・別のマシンのセッション）</div>}
      {shown && data?.found && data.steps.length === 0 && <div className="note">このターンはツールを呼んでいません</div>}
      {shown && data?.found && data.steps.length > 0 && (
        <ol className="list">
          {data.steps.map((s, i) =>
            s.text !== undefined ? (
              <li key={`said:${s.at}:${i}`} className="said">
                <span className="when">{hm(s.at)}</span>
                <div className="body"><Markdown text={s.text} /></div>
              </li>
            ) : (
              <li key={`${s.at}:${i}`}>
                <span className="when">{hm(s.at)}</span>
                <span className="tool">{s.tool || 'ツール'}</span>
                {s.summary && <code className="what">{s.summary}</code>}
                {s.note && <span className="why">{s.note}</span>}
              </li>
            ),
          )}
          {(data.more ?? 0) > 0 && <li className="more">ほか {data.more} 件（頭の {data.steps.length} 件だけ出しています）</li>}
        </ol>
      )}
    </div>
  )
}
