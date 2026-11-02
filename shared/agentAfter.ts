// 頼んだ件の「その後」（#827）。別のセッションに頼んで返答を受けたあと、人が相手と直接進めた分は送り元に届かない。
// そこで、相手の返答のあとのターンの一言を、送り元の次のターンの頭に添える（送り元は起こさない。新しく LLM を呼ばない）。
// DOM にもファイルにも `gh` にも触らない純粋関数なので shared/agentAfter.test.ts で回す（集めた材料はサーバが渡す）
import { AFTER_END, AFTER_MARK, AGENT_HEADER_MARK, deliveredId, deliveryMatcher, isHandedOnly, splitHandedReplies } from './agentMessages.ts'
import { isCompactSummaryText } from './compactSummary.ts'
import { TIME_ZONE, entityId } from './entity.ts'
import { eventKind } from './events.ts'
import type { FeedRow } from './types.ts'

export { AFTER_END, AFTER_MARK }
/** 送ってからこの間を過ぎた頼みには添えない（#827 で決めた 3 日） */
export const AFTER_KEEP_MS = 3 * 86_400_000
/** 相手ごとに並べるターンの数（直近から）。超えた分は「ほか N ターン」と数だけ */
export const AFTER_PER_TARGET = 3
/** 並べる行の合計の上限（字）。超えた分は「ほか N ターン」と数だけ */
export const AFTER_MAX_CHARS = 1000
/** 一言が無いターンに使う、本文の頭の 1 行の長さ */
export const AFTER_LINE_CHARS = 120
/**
 * そのターンの入力の行が無いとき、ターン完了の行の時刻からどれだけ前までを「そのターンのあいだ」と見るか。
 * 頼んだ件が閉じた・マージされた時刻がそのターンのあいだにあれば、状態を変えたターンとして添える
 */
export const AFTER_TURN_SPAN_MS = 10 * 60_000

/** 送った記録のうち、ここで見る分（`server/reply/agentMessages.ts` の `AgentMessage` から渡す） */
export interface AfterAsk {
  message_id: string
  /** 送り先のエンティティID */
  to: string
  /** 相手の呼び名 */
  to_name: string
  /** エージェントが書いた本文（見出しを付ける前）。頼んだ番号はここの 1 行目から引く */
  text: string
  /** どこまで添えたか（最後に添えた・数えたターン完了の行の `ts`） */
  after_at?: string
}

/** 頼んだ issue が閉じた・PR がマージされた（`gh` で引いた結果。開いている・引けない番号は渡さない） */
export interface AfterClosed {
  kind: 'issue' | 'pr'
  /** 閉じた（マージされた）時刻 */
  at: string
}

/** 送り元に添える塊と、添えたあとに覚えること */
export interface AfterResult {
  /** 本文の頭に足す塊。添えるものが無ければ空 */
  block: string
  /** 添えたターンの数（「ほか N ターン」も含む） */
  turns: number
  /** 頼みごとの、新しい「どこまで添えたか」と、もう添えない（頼んだ件が閉じた）か。変わるものだけ */
  updates: { message_id: string; after_at?: string; done?: true }[]
}

/** 頼んだ番号（#827）。**1 行目の `#N` だけ**（着手の形「#N に着手してください。」・「PR #N を見て」）。2 行目からの前提の番号は見ない */
export function askRefs(text: string): number[] {
  const first = text.trim().split('\n')[0] ?? ''
  return [...new Set([...first.matchAll(/#([1-9][0-9]{0,8})(?![0-9])/g)].map((m) => Number(m[1])))]
}

/**
 * ターンの入力が、人が打ったものか（#827 の決めたこと 3）。別のセッションから届いたメッセージ・ループの周・待ちで起きたターン・
 * 返答を渡すためだけの本文・自動の要約・入力の無いターンは人ではない
 */
export function humanTurn(input: string): boolean {
  if (isCompactSummaryText(input)) return false
  const text = splitHandedReplies(input).text.trim()
  return text !== '' && !text.startsWith(AGENT_HEADER_MARK) && !isHandedOnly(text)
}

const stamp = (ts: string): string => {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const day = d.toLocaleDateString('ja-JP', { timeZone: TIME_ZONE, month: 'numeric', day: 'numeric' })
  const time = d.toLocaleTimeString('ja-JP', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} ${time}`
}

/** 一言が無いときの 1 行（本文の頭の 1 行を `AFTER_LINE_CHARS` 字まで） */
export function headLine(text: string): string {
  const line = (text.trim().split('\n')[0] ?? '').trim()
  const chars = [...line]
  return chars.length > AFTER_LINE_CHARS ? `${chars.slice(0, AFTER_LINE_CHARS).join('')}…` : line
}

interface Turn {
  row: FeedRow
  entity: string
  /** そのターンの入力（`deliveryMatcher()` の `headOf()`。無ければ空） */
  input: string
  /** ターンの始まり（入力した瞬間の行の時刻。無ければ完了の `AFTER_TURN_SPAN_MS` 前） */
  start: number
  at: number
}

/**
 * 送り元（の頼みごと `asks`）に添える「その後」を組む（#827）。
 * - 添えるのは、相手の**返答のあと**のターン完了のうち、人の入力で始まったもの（`humanTurn()`）と、頼んだ件が閉じた・マージされた
 *   時刻をそのあいだに含むもの。**送り元からのメッセージで起きたターンは添えない**（返答と二重にしない）
 * - 頼んだ件が閉じたら、そこまでのターンと「閉じました」の 1 行を添えて終わる（`done`）。閉じたあとに始まったターンは添えない
 * - 送ってから `AFTER_KEEP_MS` を過ぎた頼み・別のリポジトリの相手への頼みは見ない（呼ぶ側が渡さない）
 * - 相手ごとに直近 `AFTER_PER_TARGET` ターン、全体で `AFTER_MAX_CHARS` 字まで。超えた分は「ほか N ターン」と数だけ（数えた分も添えた扱い）
 * - 同じ相手への頼みが 2 つあっても、同じターンは 1 回だけ
 *
 * `rows` は古い順（`deliveryMatcher()` が直前の入力の行を見る）。`lineOf` はそのターンの一言（無ければ空。空なら本文の頭の 1 行）。
 * `closed` は頼んだ番号の閉じた時刻（開いている・分からない番号は入れない）。`ownIds` は送り元が送ったメッセージの id の全部
 */
export function afterTurns(
  asks: readonly AfterAsk[],
  rows: readonly FeedRow[],
  opts: {
    lineOf: (entity: string, row: FeedRow) => string
    closed: ReadonlyMap<number, AfterClosed>
    ownIds: ReadonlySet<string>
  },
): AfterResult {
  const none: AfterResult = { block: '', turns: 0, updates: [] }
  if (asks.length === 0) return none
  const targets = new Set(asks.map((a) => a.to))
  // 頼みごとの返答の時刻（返答の行の ts）。返答がまだなら、その頼みには添えない
  const replied = new Map<string, number>()
  const turnsOf = new Map<string, Turn[]>()
  const matcher = deliveryMatcher()
  // 相手ごとの、まだターン完了の来ていない入力の行の時刻
  const started = new Map<string, number>()
  for (const r of rows) {
    const input = matcher.headOf(r)
    const entity = entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? ''))
    if (!targets.has(entity)) continue
    const kind = eventKind(r.event, r.text)
    const at = Date.parse(r.ts)
    if (kind === 'resume' && r.user_text?.trim()) started.set(entity, at)
    if (kind === 'idle' || kind === 'end') started.delete(entity)
    if (kind !== 'turn') continue
    const start = started.get(entity) ?? at - AFTER_TURN_SPAN_MS
    started.delete(entity)
    const id = deliveredId(input)
    if (id && !replied.has(id) && asks.some((a) => a.message_id === id && a.to === entity)) replied.set(id, at)
    const list = turnsOf.get(entity) ?? []
    list.push({ row: r, entity, input, start, at })
    turnsOf.set(entity, list)
  }

  const updates: AfterResult['updates'] = []
  const sections: { name: string; refs: number[]; picked: { t: Turn; state: boolean }[]; ended: { n: number; c: AfterClosed }[] }[] = []
  for (const to of targets) {
    const mine = asks.filter((a) => a.to === to && replied.has(a.message_id))
    if (mine.length === 0) continue
    const picked: { t: Turn; state: boolean }[] = []
    const ended: { n: number; c: AfterClosed }[] = []
    for (const a of mine) {
      const from = Math.max(replied.get(a.message_id)!, a.after_at ? Date.parse(a.after_at) : -Infinity)
      // 頼んだ件の、いちばん早く閉じた時刻（それより後に始まったターンは添えない）
      const closes = askRefs(a.text).flatMap((n) => {
        const c = opts.closed.get(n)
        return c ? [{ n, c }] : []
      })
      const end = closes.length ? Math.min(...closes.map((x) => Date.parse(x.c.at))) : Infinity
      for (const t of turnsOf.get(to) ?? []) {
        if (!(t.at > from) || t.start > end) continue
        const id = deliveredId(t.input)
        if (id && opts.ownIds.has(id)) continue
        const human = humanTurn(t.input)
        if (!human && !(t.start <= end && end <= t.at)) continue
        if (picked.some((p) => p.t.row === t.row)) continue
        picked.push({ t, state: !human })
      }
      // 返答より前に閉じていた（返答のターンで閉じた・マージした）なら、返答に書いてあるので「閉じました」は足さずに終わる
      for (const x of closes) if (Date.parse(x.c.at) > replied.get(a.message_id)! && !ended.some((e) => e.n === x.n)) ended.push(x)
    }
    picked.sort((x, y) => x.t.at - y.t.at)
    const last = picked.at(-1)?.t
    for (const a of mine) {
      const done = askRefs(a.text).some((n) => opts.closed.has(n))
      const moved = last !== undefined && (!a.after_at || last.at > Date.parse(a.after_at))
      if (done || moved) updates.push({ message_id: a.message_id, ...(moved ? { after_at: last.row.ts } : a.after_at ? { after_at: a.after_at } : {}), ...(done ? { done: true as const } : {}) })
    }
    if (picked.length === 0 && ended.length === 0) continue
    sections.push({ name: mine[0]!.to_name, refs: [...new Set(mine.flatMap((a) => askRefs(a.text)))], picked, ended })
  }
  if (sections.length === 0) return { ...none, updates }

  let used = 0
  let turns = 0
  const blocks: string[] = []
  for (const s of sections) {
    const lines: string[] = []
    const shown = s.picked.slice(-AFTER_PER_TARGET)
    let rest = s.picked.length - shown.length
    for (const { t, state } of shown) {
      const body = opts.lineOf(t.entity, t.row).trim() || headLine(t.row.text ?? '')
      const line = `- ${stamp(t.row.ts)}${state ? '（相手が自分で回したターン）' : ''} ${body}`
      if (used + line.length > AFTER_MAX_CHARS) {
        rest++
        continue
      }
      lines.push(line)
      used += line.length
    }
    turns += s.picked.length
    if (rest > 0) lines.push(`- ほか ${rest} ターン（相手のセッションで読めます）`)
    for (const e of s.ended) lines.push(`- #${e.n} は${e.c.kind === 'pr' ? 'マージされました' : '閉じました'}（${stamp(e.c.at)}）。この件で添えるのはここまでです`)
    const refs = s.refs.length ? `（頼んだ件: ${s.refs.map((n) => `#${n}`).join('、')}）` : ''
    blocks.push(`--- 「${s.name}」${refs}:\n${lines.join('\n')}`)
  }
  const head = `${AFTER_MARK}あなたが別のセッションに頼んだ件で、返答のあとに相手のセッションで動きがありました（人が相手と直接進めた分など。古い順）。`
  return { block: `${head}\n\n${blocks.join('\n\n')}\n\n${AFTER_END}`, turns, updates }
}

/** 本文の頭に「その後」の塊を足す。塊が空ならそのまま */
export function withAfterTurns(text: string, block: string): string {
  return block ? `${block}\n\n${text}` : text
}
