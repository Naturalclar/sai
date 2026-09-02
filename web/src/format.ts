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
