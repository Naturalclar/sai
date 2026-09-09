// 発言の本文を検索する（#230）。当たりの判定と抜粋の切り出しは DOM にもファイルにも依存しないので、
// サーバ（server/app.ts の /api/search）と画面が同じものを使い、shared/search.test.ts を node:test で回す。
//
// **索引は持たない。** 手元の実測で 9 日ぶんが 1.52MB（本文 0.42MB）、1 年でも 60MB 程度なので、
// 毎回 store の行を舐めるだけで足りる（server/ の依存ゼロも保てる）。重くなったらそのとき考える。

/** 1 回に返す上限。これを超えたら新しい方から切って `truncated` を立てる */
export const SEARCH_LIMIT = 100
/** 検索語の上限（長すぎる q でサーバを回さない） */
export const MAX_QUERY_LENGTH = 200
/** 抜粋の、当たった場所より前と後ろの文字数 */
export const EXCERPT_BEFORE = 40
export const EXCERPT_AFTER = 90
/** 切れたことを示す印 */
export const ELLIPSIS = '…'

/**
 * 検索語を語に割る。`filterPalette` / `filterSkills` / `filterReplyTargets` と同じ規則
 * （小文字にして空白で区切り、全部入っているものだけ当たり）。**規則を画面ごとに変えない**
 */
export function searchWords(query: string): string[] {
  return query.slice(0, MAX_QUERY_LENGTH).toLowerCase().split(/\s+/).filter(Boolean)
}

/** 全部の語が入っているか（小文字・部分一致・AND） */
export function matchesAll(haystack: string, words: readonly string[]): boolean {
  if (words.length === 0) return false
  const lower = haystack.toLowerCase()
  return words.every((w) => lower.includes(w))
}

/** 抜粋の中で強調する場所（開始, 長さ）。重なりと隣り合いは畳んである */
export type Hit = [start: number, length: number]

export interface Excerpt {
  /** 切り出した本文（前後が切れていれば … が付く） */
  text: string
  hits: Hit[]
}

/** 語が出てくる場所を全部。重なりは畳む（`ab` と `b` が両方あるとき二重に囲まない） */
export function findHits(text: string, words: readonly string[]): Hit[] {
  const lower = text.toLowerCase()
  const raw: Hit[] = []
  for (const w of words) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(w, from)
      if (at < 0) break
      raw.push([at, w.length])
      from = at + Math.max(1, w.length)
    }
  }
  return mergeHits(raw)
}

/** 重なり・隣り合いを 1 つに畳む。開始の昇順 */
export function mergeHits(hits: readonly Hit[]): Hit[] {
  const sorted = [...hits].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: Hit[] = []
  for (const [start, length] of sorted) {
    const last = out[out.length - 1]
    if (last && start <= last[0] + last[1]) last[1] = Math.max(last[1], start + length - last[0])
    else out.push([start, length])
  }
  return out
}

/**
 * 当たった最初の場所を中心に切り出す。前後が切れていれば `…` を付け、
 * 抜粋の中での強調の場所（`hits`）も抜粋の座標に直して返す。
 *
 * 改行は 1 つの空白に潰す（1 行に収めたいので）。**潰したあとの座標で数える**ので、
 * 呼び出し側は返ってきた `text` と `hits` だけを見ればよい
 */
export function excerptOf(body: string, words: readonly string[]): Excerpt {
  const flat = body.replace(/\s+/g, ' ').trim()
  const all = findHits(flat, words)
  const first = all[0]
  if (!first) return { text: flat.slice(0, EXCERPT_BEFORE + EXCERPT_AFTER), hits: [] }

  const from = Math.max(0, first[0] - EXCERPT_BEFORE)
  const to = Math.min(flat.length, first[0] + first[1] + EXCERPT_AFTER)
  const head = from > 0 ? ELLIPSIS : ''
  const tail = to < flat.length ? ELLIPSIS : ''
  const text = head + flat.slice(from, to) + tail

  // 抜粋に入っている分だけ、抜粋の座標に直す（先頭の … のぶんずらす）
  const shift = head.length - from
  const hits: Hit[] = []
  for (const [start, length] of all) {
    if (start + length <= from || start >= to) continue
    const s = Math.max(from, start)
    const e = Math.min(to, start + length)
    hits.push([s + shift, e - s])
  }
  return { text, hits }
}

/** 抜粋を「そのまま出す文字」と「強調する文字」に割る。画面はこれを並べるだけ（`web/src/Highlight.tsx`） */
export function splitHighlight(text: string, hits: readonly Hit[]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = []
  let at = 0
  for (const [start, length] of hits) {
    if (start > at) out.push({ text: text.slice(at, start), hit: false })
    out.push({ text: text.slice(start, start + length), hit: true })
    at = start + length
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false })
  return out
}
