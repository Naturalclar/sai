// 使用量の画面（#602）に出す文字。DOM に依存しないので usageReportLabels.test.ts で回す

/** 期間のボタンの文言 */
export function periodLabel(days: number): string {
  return days === 1 ? '24 時間' : `${days} 日`
}

/**
 * 費用（USD。API 換算の目安）。100 ドル以上は小数を出さず、1 セント未満は `<$0.01` にまとめる
 * （細かい桁まで出すと、実際に請求される額のように見える）
 */
export function usdLabel(n: number): string {
  if (!(n > 0)) return '$0'
  if (n < 0.01) return '<$0.01'
  if (n >= 100) return `$${Math.round(n).toLocaleString('en-US')}`
  return `$${n.toFixed(2)}`
}

/** 全体に占める割合（0〜1）。0 でないのに 0% と出さない */
export function shareLabel(share: number): string {
  if (!(share > 0)) return '0%'
  if (share < 0.01) return '<1%'
  return `${Math.round(Math.min(1, share) * 100)}%`
}

/** モデル名。CLI が返さなかったターンは空で来る */
export function modelLabel(key: string): string {
  return key || '（不明）'
}

/** 日付（YYYY-MM-DD）を `10/2` の形に。形が違えばそのまま */
export function dayLabel(key: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(key)
  return m ? `${Number(m[1])}/${Number(m[2])}` : key
}
