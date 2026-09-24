// バブルの隅に出す「そのターンの使用量」の文字（#411）。DOM に依存しないので usageLabel.test.ts で回す。
//
// **費用はボタンの文字に出さない**（定額プランでは実際に請求されるものではないので、数字だけ並べると誤解する）。
// title の中には出す（記録には残っているので、知りたいときに読める）。
import { totalTokens, type TurnUsage } from '../../shared/turnUsage.ts'

/** バブルの隅の狭い場所なので 4 桁から `12.3k`、7 桁から `1.2M`（キャッシュ読みは 10 万を普通に超える） */
export function shortTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return k < 10 ? `${(Math.floor(k * 10) / 10).toFixed(1)}k` : `${Math.floor(k)}k`
  }
  const m = n / 1_000_000
  return m < 10 ? `${(Math.floor(m * 10) / 10).toFixed(1)}M` : `${Math.floor(m)}M`
}

const withCommas = (n: number): string => n.toLocaleString('en-US')

/**
 * 秒。1 分を超えたら `1 分 5 秒`。**先に秒を丸めてから分と秒に割る**（#436）。
 * 分を切り捨て・秒を四捨五入と別々に丸めていたころは、繰り上がりが片方にしか効かず
 * 59.5 秒〜60 秒の境目で `1 分 60 秒`（119,600ms）や `60 秒`（59,600ms）になっていた
 */
function duration(ms: number): string {
  if (ms <= 0) return '0 秒'
  const sec = ms / 1000
  // 10 秒未満だけ 0.1 秒まで出す（短いターンは秒だけだと 0 秒に見える）
  if (sec < 10) return `${(Math.round(sec * 10) / 10).toFixed(1)} 秒`
  const whole = Math.round(sec)
  if (whole < 60) return `${whole} 秒`
  return `${Math.floor(whole / 60)} 分 ${whole % 60} 秒`
}

/** タグに出す 1 行。断られたツールがあれば添える（#387 の狙いのひとつ。返信が空振りした理由になる） */
export function usageLabel(u: TurnUsage): string {
  const tokens = `${shortTokens(totalTokens(u))} トークン`
  return u.denials > 0 ? `${tokens}・未許可 ${u.denials}` : tokens
}

/** 目立たせるか（断られたツールがある・エラーで終わった） */
export const usageLoud = (u: TurnUsage): boolean => u.denials > 0 || u.is_error

/** マウスを乗せたときの内訳。費用はここだけに出す */
export function usageTitle(u: TurnUsage): string {
  const lines = ['このターンの使用量（SAI から送った返信）']
  lines.push(`入力 ${withCommas(u.input_tokens)} / 出力 ${withCommas(u.output_tokens)} / キャッシュ読み ${withCommas(u.cache_read_input_tokens)} / キャッシュ作成 ${withCommas(u.cache_creation_input_tokens)}`)
  lines.push(`${u.num_turns} ターン・${duration(u.duration_ms)}`)
  if (u.cost_usd > 0) lines.push(`費用 $${u.cost_usd.toFixed(4)}（定額プランでは目安）`)
  if (u.model) lines.push(`モデル ${u.model}`)
  if (u.denials > 0) lines.push(`未許可で断られたツール ${u.denials} 件`)
  if (u.is_error) lines.push('エラーで終わった')
  return lines.join('\n')
}
