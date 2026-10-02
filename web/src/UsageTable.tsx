import type { UsageReportRow, UsageTotals } from './api'
import { shortTokens } from './usageLabel'
import { shareLabel, usdLabel } from './usageReportLabels'
import { UsageRowLabel, type UsageTableKind } from './UsageRowLabel'

const withCommas = (n: number): string => n.toLocaleString('en-US')

/**
 * 使用量の画面の表 1 つ（#602。セッション別・日別・モデル別で同じ列）。トークンは読み直し・キャッシュ書き・入力・出力を分けて出す
 * （読み直しが大半なので、合計だけだと何が効いているか分からない）。正確な数はマウスを乗せると出る
 */
export function UsageTable({ kind, title, head, rows, total }: { kind: UsageTableKind; title: string; head: string; rows: UsageReportRow[]; total: UsageTotals }) {
  const tokens = (n: number) => <td title={`${withCommas(n)} トークン`}>{shortTokens(n)}</td>
  return (
    <section className="usage-table">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <div className="none">この期間のターンはありません</div>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th className="name">{head}</th>
                <th>ターン</th>
                <th>読み直し</th>
                <th>キャッシュ書き</th>
                <th>入力</th>
                <th>出力</th>
                <th>合計</th>
                <th>割合</th>
                <th title="API 換算の目安。定額プランでは実際に請求される額ではありません">費用（目安）</th>
                <th title="未許可で断られたツールの数">未許可</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="name">
                    <div className="cell">
                      <UsageRowLabel kind={kind} row={r} />
                    </div>
                  </td>
                  <td title={r.errors > 0 ? `うち ${r.errors} 回はエラーで終わった` : undefined}>
                    {withCommas(r.turns)}
                    {r.errors > 0 && <span className="errors">（エラー {r.errors}）</span>}
                  </td>
                  {tokens(r.cache_read_input_tokens)}
                  {tokens(r.cache_creation_input_tokens)}
                  {tokens(r.input_tokens)}
                  {tokens(r.output_tokens)}
                  {tokens(r.tokens)}
                  <td className="share">
                    <span className="bar" style={{ width: `${Math.round(Math.min(1, r.token_share) * 100)}%` }} />
                    <span className="pct">{shareLabel(r.token_share)}</span>
                  </td>
                  <td title={`費用では全体の ${shareLabel(r.cost_share)}`}>{usdLabel(r.cost_usd)}</td>
                  <td className={r.denials > 0 ? 'denied' : ''}>{r.denials > 0 ? withCommas(r.denials) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="name">合計</td>
                <td>{withCommas(total.turns)}</td>
                {tokens(total.cache_read_input_tokens)}
                {tokens(total.cache_creation_input_tokens)}
                {tokens(total.input_tokens)}
                {tokens(total.output_tokens)}
                {tokens(total.tokens)}
                <td />
                <td>{usdLabel(total.cost_usd)}</td>
                <td>{total.denials > 0 ? withCommas(total.denials) : ''}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  )
}
