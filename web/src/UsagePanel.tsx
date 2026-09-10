import { hm } from './format'
import { limitKindLabel, resetLabel } from '../../shared/usage.ts'
import { UsageBar } from './UsageBar'
import type { UsageResponse } from './api'

/**
 * 使用量の詳細（UsageChip を押すと出る）。どちらも 5時間 / 週のゲージ。
 * **Claude の割合はステータスラインを設定している人しか取れない**ので、無いときは設定の場所を案内する
 * （割合が出ないのは不具合ではない。#250）
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
          {usage.claude.primary && <UsageBar window={usage.claude.primary} now={now} />}
          {usage.claude.secondary && <UsageBar window={usage.claude.secondary} now={now} />}
          {usage.claude.limited && (
            <p className="usage-hit">
              {limitKindLabel(usage.claude.limited.kind) && `${limitKindLabel(usage.claude.limited.kind)}の`}上限に当たっています（
              {resetLabel(usage.claude.limited.resets_at, now)}）
            </p>
          )}
        </section>
      )}
      {!usage.claude?.primary && (
        <p className="usage-note">
          Claude の使用率は、ステータスライン（<code>feed/statusline.py</code>）を設定すると出ます。API は叩きません。
        </p>
      )}
      {!usage.codex && <p className="usage-note">Codex の使用量は見つかりませんでした（この Mac で Codex を使っていない、または記録がまだありません）。</p>}
    </div>
  )
}
