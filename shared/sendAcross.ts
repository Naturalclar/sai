// 別のリポジトリのセッションへ `sai_send` で送ってよい組（#747）。既定は空（同じリポジトリの中だけ）で、人が自分のメニューで許した組だけまたげる。
// 置き場は `settings.json` の `send_across`。変えられるのは同一オリジンの PUT だけ（エージェントの道具からは増やせない）。
// DOM にもファイルにも触らない純粋関数だけを置く（shared/sendAcross.test.ts）
import type { SendAcrossPair } from './types.ts'

/** 持てる組の数（設定のファイルと一覧を膨らませない） */
export const SEND_ACROSS_MAX = 30

/**
 * `from` のリポジトリのセッションが、`to` のリポジトリのセッションへ送ってよいか（同じリポジトリは別に見る。ここは「またぐ」分だけ）。
 *
 * **組は向きつき**（A → B を許しても B → A は送れない）。「仕事のリポジトリから個人のリポジトリへ頼む」と、その逆は流れる中身が違うので、
 * 片方だけ許せるようにしてある。**双方向にするなら、変えるのはこの関数だけ**（`p.from === to && p.to === from` も通す）。
 * リポジトリの名前は大文字小文字を見ずに比べる（GitHub の名前は区別しない）
 */
export function mayCross(pairs: readonly SendAcrossPair[], from: string, to: string): boolean {
  if (!from || !to) return false
  const f = from.toLowerCase()
  const t = to.toLowerCase()
  if (f === t) return false
  return pairs.some((p) => p.from.toLowerCase() === f && p.to.toLowerCase() === t)
}

/**
 * 設定に入れる組を整える。読めるものだけ・同じ組は 1 つ・自分から自分への組は落とす。`known`（記録で知っているリポジトリ）を
 * 渡せば、その中の名前だけを通す（**任意の名前を持たせない**。名前は `known` の書き方に揃える）。形が違えば文で返す
 */
export function cleanPairs(raw: unknown, known?: readonly string[]): SendAcrossPair[] | string {
  if (!Array.isArray(raw)) return 'send_across は { from, to } の配列で送ってください'
  if (raw.length > SEND_ACROSS_MAX) return `send_across に持てるのは ${SEND_ACROSS_MAX} 組までです`
  const pick = (name: string): string => (known ? (known.find((k) => k.toLowerCase() === name.toLowerCase()) ?? '') : name)
  const out: SendAcrossPair[] = []
  for (const item of raw) {
    const v = (item ?? {}) as { from?: unknown; to?: unknown }
    if (!item || typeof item !== 'object' || typeof v.from !== 'string' || typeof v.to !== 'string') return 'send_across は { from, to } の配列で送ってください'
    const from = pick(v.from.trim())
    const to = pick(v.to.trim())
    if (!from || !to) return `記録で知っているリポジトリだけを選べます: ${!from ? v.from : v.to}`
    if (from.toLowerCase() === to.toLowerCase()) return '同じリポジトリの中は、いつでも送れます（組にしなくてよい）'
    if (!out.some((p) => p.from.toLowerCase() === from.toLowerCase() && p.to.toLowerCase() === to.toLowerCase())) out.push({ from, to })
  }
  return out
}

/** 設定のファイルから読むとき。読めない組は落とす（1 つ壊れていても、ほかの組を捨てない） */
export function readPairs(raw: unknown): SendAcrossPair[] {
  if (!Array.isArray(raw)) return []
  const out: SendAcrossPair[] = []
  for (const item of raw.slice(0, SEND_ACROSS_MAX)) {
    const one = cleanPairs([item])
    if (typeof one !== 'string' && one[0] && !mayCross(out, one[0].from, one[0].to)) out.push(one[0])
  }
  return out
}

/** 画面に出す 1 組（`A → B`） */
export function pairLabel(p: SendAcrossPair): string {
  return `${p.from} → ${p.to}`
}

/** 同じ組か（名前は大文字小文字を見ない） */
export function samePair(a: SendAcrossPair, b: SendAcrossPair): boolean {
  return a.from.toLowerCase() === b.from.toLowerCase() && a.to.toLowerCase() === b.to.toLowerCase()
}

/**
 * いまの組に 1 つ足す（#747）。足す組は `cleanPairs()` と同じ検査を通す（`known` の名前だけ・自分から自分は不可）。
 * もうあれば何も変えない。上限を超えるなら文で返す。**いま持っている組は検査し直さない**
 * （前に許した組の片方が記録の窓から出ても、ほかの組を足す・外すのを止めない）
 */
export function addPair(pairs: readonly SendAcrossPair[], raw: unknown, known: readonly string[]): SendAcrossPair[] | string {
  const one = cleanPairs([raw], known)
  if (typeof one === 'string') return one === 'send_across は { from, to } の配列で送ってください' ? 'send_across_add は { from, to } で送ってください' : one
  const pair = one[0]!
  if (pairs.some((p) => samePair(p, pair))) return [...pairs]
  if (pairs.length >= SEND_ACROSS_MAX) return `send_across に持てるのは ${SEND_ACROSS_MAX} 組までです`
  return [...pairs, pair]
}

/** いまの組から 1 つ外す（#747）。名前が記録に無くても外せる。形が違えば文で返す */
export function removePair(pairs: readonly SendAcrossPair[], raw: unknown): SendAcrossPair[] | string {
  const v = (raw ?? {}) as { from?: unknown; to?: unknown }
  if (!raw || typeof raw !== 'object' || typeof v.from !== 'string' || typeof v.to !== 'string') return 'send_across_remove は { from, to } で送ってください'
  const pair = { from: v.from.trim(), to: v.to.trim() }
  return pairs.filter((p) => !samePair(p, pair))
}
