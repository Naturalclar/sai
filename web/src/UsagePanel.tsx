import { hm } from './format'
import { limitKindLabel, resetLabel } from '../../shared/usage.ts'
import { UsageBar } from './UsageBar'
import type { UsageResponse } from './api'
import { claudeFreshness, CLAUDE_USAGE_WHY } from './usageChips'

/**
 * 使用量の詳細（UsageChip を押すと出る）。どちらも 5時間 / 週のゲージ。
 * **Claude の割合はステータスラインを設定している人しか取れない**ので、無いときは設定の場所を案内する
 * （割合が出ないのは不具合ではない。#250）
 */
export function UsagePanel({ usage, now, onNavigate }: { usage: UsageResponse; now: number; onNavigate?: () => void }) {
  // Claude の割合がいつの値か・5 時間が欠けているか（#694）。判定は usageChips.ts の 1 か所
  const fresh = claudeFreshness(usage.claude, now)
  return (
    <div className="usage-panel" role="dialog" aria-label="使用量">
      {usage.codex && (
        <section>
          <h3>
            Codex
            {usage.codex.plan && <span className="usage-plan">{usage.codex.plan}</span>}
            {usage.codex.at && <span className="usage-at">{hm(usage.codex.at)} 時点</span>}
          </h3>
          <UsageBar window={usage.codex.primary} now={now} />
          {usage.codex.secondary && <UsageBar window={usage.codex.secondary} now={now} />}
        </section>
      )}
      {usage.claude && (
        <section>
          <h3>
            Claude
            {/* 今日でなければ日付も出し、古ければ目立たせて「何時間前」を添える（#694） */}
            {fresh.at && (
              <span className={`usage-at${fresh.stale ? ' stale' : ''}`}>
                {fresh.at}
                {fresh.stale && ` · ${fresh.age}の値`}
              </span>
            )}
          </h3>
          {usage.claude.primary && <UsageBar window={usage.claude.primary} now={now} />}
          {/* 週は来ているのに 5 時間が来ていないときは、黙って消さずにそう出す */}
          {fresh.fiveHourMissing && (
            <div className="usage-bar missing">
              <div className="usage-bar-top">
                <span className="usage-window">5時間</span>
                <span className="usage-missing">取れていません</span>
              </div>
            </div>
          )}
          {usage.claude.secondary && <UsageBar window={usage.claude.secondary} now={now} />}
          {usage.claude.limited && (
            <p className="usage-hit">
              {limitKindLabel(usage.claude.limited.kind) && `${limitKindLabel(usage.claude.limited.kind)}の`}上限に当たっています（
              {resetLabel(usage.claude.limited.resets_at, now)}）
            </p>
          )}
          {(fresh.stale || fresh.fiveHourMissing) && <p className="usage-note">{CLAUDE_USAGE_WHY}</p>}
        </section>
      )}
      {/* 割合が 1 つも取れないときだけ案内する（#347。週だけ取れている人に「設定すると出ます」は嘘になる） */}
      {!usage.claude?.primary && !usage.claude?.secondary && (
        <p className="usage-note">
          Claude の使用率は、SAI から Claude に返信するか、ステータスライン（<code>feed/statusline.py</code>）を設定すると出ます。API は叩きません。
        </p>
      )}
      {/* トークンと費用の内訳（#602）。SAI から送った Claude の返信の合計を、セッション別・日別・モデル別に見る */}
      <p className="usage-more">
        <a href="#/usage" onClick={onNavigate}>トークンと費用の内訳を見る</a>
      </p>
      {!usage.codex && <p className="usage-note">Codex の使用量は見つかりませんでした（この Mac で Codex を使っていない、または記録がまだありません）。</p>}
    </div>
  )
}
