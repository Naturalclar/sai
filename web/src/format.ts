const pad = (n: number) => String(n).padStart(2, '0')

export function parseTs(ts: string): Date | null {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? null : d
}

export const hm = (ts: string) => {
  const d = parseTs(ts)
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : ''
}

export const ymd = (ts: string) => {
  const d = parseTs(ts)
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : ''
}

export const md = (ts: string) => {
  const d = parseTs(ts)
  return d ? `${d.getMonth() + 1}/${d.getDate()}` : ''
}

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土']

export const dayLabel = (ts: string) => {
  const d = parseTs(ts)
  if (!d) return ts
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} (${WEEKDAY[d.getDay()]})`
}

export const minutesBetween = (a: string, b: string) => {
  const da = parseTs(a)
  const db = parseTs(b)
  return da && db ? Math.abs(db.getTime() - da.getTime()) / 60000 : Infinity
}

/**
 * 処理中の返信の経過。1分未満は空（「送信中…」のまま）、あとは「3分」「1時間5分」。
 * now は描画側がポーリングの updatedAt から渡す（描画中に Date.now() を呼ばない。3秒ごとに進めば十分）
 */
export const elapsedLabel = (since: string, now: number) => {
  const d = parseTs(since)
  if (!d) return ''
  const minutes = Math.floor((now - d.getTime()) / 60000)
  if (minutes < 1) return ''
  if (minutes < 60) return `${minutes}分`
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`
}

/** これを超えて処理中なら「長引いている」として見た目を変える */
export const LONG_REPLY_MS = 5 * 60000
