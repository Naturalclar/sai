// ヘッダの使用量のチップに、何をどの順で出すか（#347）。DOM に触らないので node:test で回す（usageChips.test.ts）。
// 言い換え（%・戻る時刻）は shared/usage.ts、描画は UsageChip.tsx。
import { isUsageStale, resetLabel, usageAgeLabel, usageAtLabel, usageLevel, windowExpired, type UsageLevel } from '../../shared/usage.ts'
import type { ClaudeUsage, CodexUsage, UsageResponse, UsageWindow } from '../../shared/types.ts'

/** 色の強さの順。複数の枠のうち一番きついものを採る */
const RANK: Record<UsageLevel, number> = { ok: 0, warn: 1, high: 2 }

export interface UsageChipPart {
  agent: 'claude' | 'codex'
  name: string
  /** 割合。上限中だけが分かっていて割合が取れないとき・更新待ち（`waiting`）のときは null */
  percent: number | null
  /** 5 時間ではなく週の枠。5 時間と混ざって見えないよう、画面は印を付ける */
  week: boolean
  /** いま上限に当たっている（Claude だけ） */
  limited: boolean
  /** 割合が古い（#694。Codex は #726）。画面は割合を薄くして `age` を添える */
  stale: boolean
  /** 枠の復帰時刻を過ぎていて、いまの割合が分からない（#726）。画面は割合の代わりに「更新待ち」と出す */
  waiting: boolean
  /** どれだけ前の値か（「27時間前」）。古くなければ空 */
  age: string
}

/**
 * なぜ Claude の値が古くなるのか・5 時間が出ないのか（#694）。パネルとチップの title が同じ文を出す。
 * 「届いていない」とは言い切らない（変わっていないだけのこともある）
 */
export const CLAUDE_USAGE_WHY = 'Claude の使用率は、Claude Code が動いたとき（端末のステータスライン・SAI から回した返信）にだけ届きます。そのあと別の所で使っていれば、実際より低いことがあります。'

export interface ClaudeFreshness {
  /** 「10/5 10:57 時点」。いつの値か分からなければ空 */
  at: string
  /** 「27時間前」。1 分未満・分からなければ空 */
  age: string
  /** 値が `USAGE_STALE_MS` より前のもの */
  stale: boolean
  /** 週は取れているのに 5 時間の枠が無い（「取れていません」と出す。割合が 1 つも無いときは設定の案内のほうを出す） */
  fiveHourMissing: boolean
}

/**
 * Claude の割合がいつの値で、何が欠けているか（#694）。**古いかどうかを見るのは割合があるときだけ**
 * （上限中だけの記録の `at` は transcript の行の時刻で、割合の古さではない）。`now` は取ってきた時刻
 */
export function claudeFreshness(claude: ClaudeUsage | undefined, now: number): ClaudeFreshness {
  const has = Boolean(claude?.primary || claude?.secondary)
  const stale = has && isUsageStale(claude?.at, now)
  return {
    at: claude ? usageAtLabel(claude.at, now) : '',
    age: has ? usageAgeLabel(claude?.at, now) : '',
    stale,
    fiveHourMissing: Boolean(claude && !claude.primary && claude.secondary),
  }
}

/** 更新待ちの枠に添える文（#726） */
export const USAGE_WAITING_NOTE = '次に使うと更新'

/**
 * 更新待ちの枠の説明（「10/5 15:38 に戻った・次に使うと更新」）。復帰時刻を過ぎていない枠は空。
 * パネルのゲージとチップの title が同じ文を出す（文を 2 か所で組まない。#730 のレビュー）
 */
export function waitingNote(w: UsageWindow | undefined, now: number): string {
  if (!w || !windowExpired(w, now)) return ''
  return `${resetLabel(w.resets_at ?? 0, now, { past: true })}・${USAGE_WAITING_NOTE}`
}

export interface CodexFreshness {
  /** 「10/5 12:47 時点」（rollout から拾った行の時刻）。分からなければ空 */
  at: string
  /** 「47時間前」。1 分未満・分からなければ空 */
  age: string
  /** 値を拾ってから `USAGE_STALE_MS` より長く経っている（Codex を使っていないあいだは rollout が増えない） */
  stale: boolean
  /** 5 時間の枠の復帰時刻を過ぎている（割合は前の枠のもの。チップは割合を出さない） */
  waiting: boolean
  /**
   * 5 時間の枠は過ぎているが、**週の枠がまだ生きていて色の付く高さ**（`USAGE_WARN` 以上）のとき、その週の枠。
   * チップは「更新待ち」の代わりにこれを週の印付きで出す（週で使い切っているのに、薄い「更新待ち」だけになるのを防ぐ。#730 のレビュー）
   */
  week?: UsageWindow
}

/**
 * Codex の割合がいつの値か（#726）。前は「古いのは使っていないときだけ」として印を付けていなかったが、
 * 使っていないときこそ「いま回せるか」を見るので、Claude と同じ閾値で付ける。`now` は取ってきた時刻
 */
export function codexFreshness(codex: CodexUsage | undefined, now: number): CodexFreshness {
  const waiting = windowExpired(codex?.primary, now)
  const second = codex?.secondary
  const week = waiting && second && !windowExpired(second, now) && usageLevel(second.used_percent) !== 'ok' ? second : undefined
  return {
    at: codex ? usageAtLabel(codex.at, now) : '',
    age: codex ? usageAgeLabel(codex.at, now) : '',
    stale: Boolean(codex) && isUsageStale(codex?.at, now),
    waiting,
    ...(week ? { week } : {}),
  }
}

/**
 * ヘッダに出すチップ。**Claude が先**（狭い画面で入らないときに落とすのは Codex 側。#347）。
 *
 * **Claude は 5 時間の枠が無ければ週に落とす**: Claude Code は `rate_limits` に `five_hour` を載せないことがあり
 * （手元では `seven_day` だけの日があった）、5 時間だけを見ていると、割合が取れていてパネルには週のゲージが
 * 出ているのに、チップからは Claude が丸ごと消えていた。上限中（`limited`）は割合が無くても出す。
 * Codex は 5 時間の枠（週はパネルで見る）。5 時間の枠が復帰時刻を過ぎていて、週の枠が色の付く高さなら週を出す。
 *
 * `now`（取ってきた時刻）を渡すと、割合が古いとき `stale` と `age` を付ける（Claude は #694、Codex は #726）。
 * **復帰時刻を過ぎた枠は割合を出さず `waiting`**（#726。0% と決めつけない・チップごと落とさない）。そのときは「古い」は重ねない
 */
export function usageChips(usage: UsageResponse, now: number = 0): UsageChipPart[] {
  const parts: UsageChipPart[] = []
  const claude = usage.claude
  const window = claude?.primary ?? claude?.secondary
  const fresh = claudeFreshness(claude, now)
  if (claude && (window || claude.limited)) {
    // サーバは過ぎた枠を落とすが、30 秒のキャッシュや時計のずれで過ぎた枠が届くことがある。パネルのゲージと同じく割合を出さない（#730 のレビュー）
    const waiting = windowExpired(window, now)
    parts.push({
      agent: 'claude',
      name: 'Claude',
      percent: window && !waiting ? window.used_percent : null,
      week: Boolean(window && !claude.primary),
      limited: Boolean(claude.limited),
      stale: fresh.stale && !waiting,
      age: fresh.stale && !waiting ? fresh.age : '',
      waiting,
    })
  }
  if (usage.codex) {
    const c = codexFreshness(usage.codex, now)
    // 週の枠が高いときは、そちらを割合として出す（更新待ちにしない）
    const waiting = c.waiting && !c.week
    const stale = c.stale && !c.waiting
    parts.push({
      agent: 'codex',
      name: 'Codex',
      percent: c.week ? c.week.used_percent : waiting ? null : usage.codex.primary.used_percent,
      week: Boolean(c.week),
      limited: false,
      // 週に落としたときは、その値がいつのものかを添える（5 時間の枠は過ぎているので、値は古い）
      stale: stale || (Boolean(c.week) && c.stale),
      age: stale || (c.week && c.stale) ? c.age : '',
      waiting,
    })
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
