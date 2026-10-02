import { useCallback, useEffect, useState } from 'react'
import { USAGE_REPORT_DAYS } from '../../shared/usageReport.ts'
import { api, type UsageReportResponse } from './api'
import { useLocalState } from './hooks'
import { BackLink } from './BackLink'
import { RefreshButton } from './RefreshButton'
import { UsageTable } from './UsageTable'
import { shortTokens } from './usageLabel'
import { periodLabel, shareLabel, usdLabel } from './usageReportLabels'
import type { PaneProps } from './App'

interface Loaded {
  data: UsageReportResponse
  at: Date
}

/** 期間のボタンは短い順に並べる（既定は `USAGE_REPORT_DAYS` の先頭 = 7 日） */
const PERIODS = [...USAGE_REPORT_DAYS].sort((a, b) => a - b)

/**
 * 使用量の画面（#602）。トークンと費用を、期間を切り替えてセッション別・日別・モデル別に見る。
 *
 * **数えるのは SAI が起こした Claude のターンだけ**（`turn-usage.jsonl`）。端末で直接回したターンと Codex / OpenCode は入らないので、
 * 画面にそう書く。費用は API 換算の目安（定額プランでは実際に請求される額ではない）。
 * 3 秒のポーリングには乗せない。開いたとき・期間を切り替えたとき・「更新」を押したときだけ取る
 */
export function UsageView({ onStatus, onOpenSidebar }: Pick<PaneProps, 'onStatus' | 'onOpenSidebar'>) {
  const [ui, setUi] = useLocalState<{ days: number }>('sai.usage', { days: USAGE_REPORT_DAYS[0] })
  const days = (USAGE_REPORT_DAYS as readonly number[]).includes(ui.days) ? ui.days : USAGE_REPORT_DAYS[0]
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)

  const load = useCallback((d: number) => {
    setBusy(true)
    return api.usageReport(d).then(
      (data) => {
        setLoaded({ data, at: new Date() })
        setError('')
        setBusy(false)
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      },
    )
  }, [])

  // 開いたときと、期間を切り替えたとき（前の期間の応答が後から届いても捨てる）
  useEffect(() => {
    let alive = true
    void api.usageReport(days).then(
      (data) => alive && (setLoaded({ data, at: new Date() }), setError(''), setBusy(false)),
      (err: unknown) => alive && (setError(err instanceof Error ? err.message : String(err)), setBusy(false)),
    )
    return () => {
      alive = false
    }
  }, [days])

  useEffect(() => onStatus(loaded?.at ?? null, error || null), [loaded, error, onStatus])

  // 切り替えた直後は前の期間の表を出さない
  const data = loaded && loaded.data.days === days ? loaded.data : null
  const total = data?.total

  return (
    <section className="usage-view">
      <BackLink onOpenSidebar={onOpenSidebar} />
      <div className="chat-head">
        <h1>使用量</h1>
        <span className="meta">SAI から送った Claude の返信</span>
        <span className="pr-actions">
          {PERIODS.map((d) => (
            <button
              key={`period:${d}`}
              type="button"
              className={d === days ? 'on' : ''}
              aria-pressed={d === days}
              onClick={() => {
                if (d === days) return
                setBusy(true)
                setUi({ days: d })
              }}
            >
              {periodLabel(d)}
            </button>
          ))}
          <RefreshButton busy={busy} onClick={() => void load(days)} />
        </span>
      </div>
      <div className="usage-body">
        <p className="note">
          数えているのは <b>SAI から送った Claude の返信だけ</b>です。端末で直接回したターンと Codex / OpenCode は入りません。
          費用は <b>API 換算の目安</b>で、定額プランでは実際に請求される額ではありません。
        </p>
        {error && !data && <div className="empty">取得失敗: {error}</div>}
        {!data && !error && <div className="empty">読んでいます…</div>}
        {data && total && (
          <>
            <dl className="usage-total">
              <div>
                <dt>ターン</dt>
                <dd>{total.turns.toLocaleString('en-US')}</dd>
              </div>
              <div>
                <dt>トークン</dt>
                <dd title={`${total.tokens.toLocaleString('en-US')} トークン`}>{shortTokens(total.tokens)}</dd>
              </div>
              <div>
                <dt>うち読み直し</dt>
                <dd title={`${total.cache_read_input_tokens.toLocaleString('en-US')} トークン`}>{shareLabel(total.tokens > 0 ? total.cache_read_input_tokens / total.tokens : 0)}</dd>
              </div>
              <div>
                <dt>費用（目安）</dt>
                <dd>{usdLabel(total.cost_usd)}</dd>
              </div>
              <div>
                <dt>未許可</dt>
                <dd>{total.denials.toLocaleString('en-US')}</dd>
              </div>
            </dl>
            <UsageTable kind="session" title="セッション別" head="セッション" rows={data.sessions} total={total} />
            <UsageTable kind="day" title="日別" head="日" rows={data.by_day} total={total} />
            <UsageTable kind="model" title="モデル別" head="モデル" rows={data.by_model} total={total} />
          </>
        )}
      </div>
    </section>
  )
}
