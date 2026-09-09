import { hm } from './format'
import { limitKindLabel, resetLabel } from '../../shared/usage.ts'
import { UsageBar } from './UsageBar'
import type { UsageResponse } from './api'

/**
 * 使用量の詳細（UsageChip を押すと出る）。Codex は 5時間 / 週のゲージ、Claude は上限に当たっているときだけ復帰時刻。
 * **エージェントで取れるものが違う**ので、Claude 側にはその理由も書く（割合が出ないのは不具合ではない）
 */
export function UsagePanel({ usage, now }: { usage: UsageResponse; now: number }) {
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
            {usage.claude.at && <span className="usage-at">{hm(usage.claude.at)} 時点</span>}
          </h3>
          <p className="usage-hit">
            {limitKindLabel(usage.claude.kind) && `${limitKindLabel(usage.claude.kind)}の`}上限に当たっています（{resetLabel(usage.claude.resets_at, now)}）
          </p>
        </section>
      )}
      {!usage.claude && (
        <p className="usage-note">
          Claude は上限に当たったときしか手元に記録が残らないので、いつもの使用率は出せません（API は叩きません）。
        </p>
      )}
      {!usage.codex && <p className="usage-note">Codex の使用量は見つかりませんでした（この Mac で Codex を使っていない、または記録がまだありません）。</p>}
    </div>
  )
}
