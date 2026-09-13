// ヘッダの使用量のチップに、何をどの順で出すか（#347）。DOM に触らないので node:test で回す（usageChips.test.ts）。
// 言い換え（%・戻る時刻）は shared/usage.ts、描画は UsageChip.tsx。
import { usageLevel, type UsageLevel } from '../../shared/usage.ts'
import type { UsageResponse } from './api'

/** 色の強さの順。複数の枠のうち一番きついものを採る */
const RANK: Record<UsageLevel, number> = { ok: 0, warn: 1, high: 2 }

export interface UsageChipPart {
  agent: 'claude' | 'codex'
  name: string
  /** 割合。上限中だけが分かっていて割合が取れないときは null */
  percent: number | null
  /** 5 時間ではなく週の枠。5 時間と混ざって見えないよう、画面は印を付ける */
  week: boolean
  /** いま上限に当たっている（Claude だけ） */
  limited: boolean
}

/**
 * ヘッダに出すチップ。**Claude が先**（狭い画面で入らないときに落とすのは Codex 側。#347）。
 *
 * **Claude は 5 時間の枠が無ければ週に落とす**: Claude Code は `rate_limits` に `five_hour` を載せないことがあり
 * （手元では `seven_day` だけの日があった）、5 時間だけを見ていると、割合が取れていてパネルには週のゲージが
 * 出ているのに、チップからは Claude が丸ごと消えていた。上限中（`limited`）は割合が無くても出す。
 * Codex は今までどおり 5 時間の枠（週はパネルで見る）
 */
export function usageChips(usage: UsageResponse): UsageChipPart[] {
  const parts: UsageChipPart[] = []
  const claude = usage.claude
  const window = claude?.primary ?? claude?.secondary
  if (claude && (window || claude.limited)) {
    parts.push({
      agent: 'claude',
      name: 'Claude',
      percent: window ? window.used_percent : null,
      week: Boolean(window && !claude.primary),
      limited: Boolean(claude.limited),
    })
  }
  if (usage.codex) {
    parts.push({ agent: 'codex', name: 'Codex', percent: usage.codex.primary.used_percent, week: false, limited: false })
  }
  return parts
}

/** ヘッダの色。出すチップのうち一番きついものに合わせる（片方が 95% ならヘッダを赤くする） */
export function chipsLevel(parts: readonly UsageChipPart[]): UsageLevel {
  return parts.reduce<UsageLevel>((worst, p) => {
    if (p.percent === null) return worst
    const level = usageLevel(p.percent)
    return RANK[level] > RANK[worst] ? level : worst
  }, 'ok')
}
