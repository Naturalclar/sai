// 人の判断待ち（「決めること」）を、issue と PR の文から拾う（#762）。**見出しと箇条書きを読むだけの純粋関数**で、
// LLM は呼ばない・`gh` も叩かない（引くのは `server/git/issues.ts`、並べるのは `decisions.ts`）。
//
// 読む見出し（書き方の決まりは AGENTS.md の「決めることの書き方」）:
//   issue の本文        `## 決めること`（番号つき）
//   issue のコメント    `## 決めたこと（日付）`（どの番号を決めたかを「決めること 2」の形で書く）と、その中の `### まだ決めていないこと`
//   閉じるコメント      `### 決めないまま閉じること`
//   PR の本文           `## 人が決めること`
//
// **出しすぎる側に倒す**: 番号で突き合わせられない「決めたこと」では、本文の項目を決まったと見なさない。
import { localDate } from '../../shared/entity.ts'

/** 項目の 1 行をどこまで出すか（本文は載せない。#688） */
export const DECISION_LINE_CHARS = 100
/** おすすめの 1 行をどこまで出すか */
export const DECISION_RECOMMEND_CHARS = 80

/** `gh issue list` / `gh pr list` から来た 1 件（要る項目だけ） */
export interface DecisionSource {
  kind: 'issue' | 'pr'
  number: number
  title: string
  state: 'open' | 'closed'
  body: string
  /** ISO の時刻 */
  createdAt: string
  comments: { body: string; createdAt: string }[]
}

/** まだ決まっていない 1 項目 */
export interface Pending {
  kind: 'issue' | 'pr'
  number: number
  title: string
  state: 'open' | 'closed'
  /** 本文の「決めること」の番号。番号の無い項目・コメントから拾った項目には無い */
  n?: number
  /** どの見出しから拾ったか */
  from: 'body' | 'remaining' | 'closing' | 'pr'
  /** 項目の 1 行（切ってある） */
  text: string
  /** 書かれた日（`Asia/Tokyo`） */
  date: string
  /** その項目に付いているおすすめ（あれば 1 行） */
  recommend?: string
}

interface Section {
  /** 見出しの文（`#` を外したもの） */
  title: string
  level: number
  lines: string[]
}

interface Item {
  n?: number
  /** 項目の 1 行目 */
  head: string
  /** 項目の全部（続きの行・入れ子の箇条書きも）。おすすめを探すためだけに使う */
  whole: string
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^\s*(?:```|~~~)/

/**
 * 見出しが `match` に当たる節を、出てきた順に返す。節は、同じか上の階層の見出しまで（下の階層の見出しは節の中）。
 * コードブロックの中の `#` は見出しにしない
 */
export function sections(markdown: string, match: (title: string) => boolean): Section[] {
  const found: Section[] = []
  const open: Section[] = []
  let fenced = false
  for (const line of (markdown ?? '').split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced
    const h = fenced ? null : HEADING.exec(line)
    if (h) {
      const level = h[1]!.length
      // 同じか上の階層の見出しで、開いている節を閉じる
      while (open.length && open[open.length - 1]!.level >= level) open.pop()
      for (const s of open) s.lines.push(line)
      if (match(h[2]!)) {
        const s: Section = { title: h[2]!, level, lines: [] }
        found.push(s)
        open.push(s)
      }
      continue
    }
    for (const s of open) s.lines.push(line)
  }
  return found
}

const NUMBERED = /^ {0,1}(\d{1,3})[.)]\s+(.*)$/
const BULLET = /^ {0,1}[-*+]\s+(.*)$/
/** 「決めることは無い」と書いただけの行 */
const NOTHING = /^(?:\*\*)?(?:なし|無し|ない|ありません|特になし|特に無し|なし。|\(なし\)|（なし）|none|n\/a)(?:\*\*)?[。.]?$/i

/**
 * 節のいちばん上の階層の箇条書き（番号つき・点）を項目にする。字下げした行・入れ子の箇条書きは、前の項目の続き。
 * 箇条書きが 1 つも無ければ、最初の段落の 1 行目を 1 項目にする（「なし」と書いただけなら 0 件）
 */
export function listItems(lines: readonly string[]): Item[] {
  const items: Item[] = []
  let fenced = false
  let cur: Item | null = null
  const loose: string[] = []
  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    // 節の中の小見出しは項目にしない（項目の続きにも入れない）
    if (HEADING.test(line)) {
      cur = null
      continue
    }
    const num = NUMBERED.exec(line)
    const dot = num ? null : BULLET.exec(line)
    if (num || dot) {
      const head = (num ? num[2]! : dot![1]!).trim()
      cur = { ...(num ? { n: Number(num[1]) } : {}), head, whole: head }
      items.push(cur)
      continue
    }
    if (!line.trim()) continue
    if (cur) cur.whole += `\n${line.trim()}`
    else loose.push(line.trim())
  }
  const real = items.filter((i) => !NOTHING.test(i.head))
  if (real.length || items.length) return real
  const first = loose[0]
  return first && !NOTHING.test(first) ? [{ head: first, whole: loose.join('\n') }] : []
}

/** 全角の数字を半角に */
const half = (s: string): string => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))

/**
 * 文の中で名指しされた「決めること」の番号（`決めること 2`・`「決めること」1・2`・`決めること 1〜5`・`決めること 1, 3`）。
 * 番号の無い「決めること」は何も返さない（突き合わせられないので、決まったと見なさない）
 */
export function namedNumbers(text: string): number[] {
  const out = new Set<number>()
  const re = /決めること[」』\s]*(?:の\s*)?(\d{1,3}(?:\s*(?:[・,、とや]|〜|~|-|から)\s*\d{1,3})*)/g
  for (const m of half(text ?? '').matchAll(re)) {
    const parts = m[1]!.split(/\s*([・,、とや]|〜|~|-|から)\s*/)
    let prev: number | undefined
    for (let i = 0; i < parts.length; i += 2) {
      const n = Number(parts[i])
      const sep = i > 0 ? parts[i - 1] : ''
      // 範囲（`1〜5`）は間も全部。広すぎる範囲は読み違いとして端だけ
      if (prev !== undefined && /^(?:〜|~|-|から)$/.test(sep!) && n > prev && n - prev <= 50) for (let k = prev + 1; k < n; k++) out.add(k)
      out.add(n)
      prev = n
    }
  }
  return [...out].sort((a, b) => a - b)
}

const clip = (s: string, max: number): string => {
  const chars = [...s]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s
}
/** 太字・斜体の印と前後の空白を外して 1 行に */
const plain = (s: string): string => s.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim()

/** 項目の中の「おすすめ」の 1 文。無ければ undefined */
export function recommendOf(whole: string): string | undefined {
  const text = plain(whole)
  const at = text.indexOf('おすすめ')
  if (at < 0) return undefined
  // その文の頭（前の `。` か `（` のあと）から、次の `。` まで
  const from = Math.max(text.lastIndexOf('。', at), text.lastIndexOf('（', at), text.lastIndexOf('(', at)) + 1
  const end = text.indexOf('。', at)
  let sentence = text.slice(from, end < 0 ? undefined : end).trim()
  // 括弧の中から始まった文は、閉じる括弧まで（`色の数（おすすめ: 8）` → `おすすめ: 8`）。文の中の括弧は残す
  const count = (re: RegExp) => (sentence.match(re) ?? []).length
  if (count(/[）)]/g) > count(/[（(]/g)) sentence = sentence.replace(/[）)][^）)]*$/, '').trim()
  return sentence ? clip(sentence, DECISION_RECOMMEND_CHARS) : undefined
}

const starts = (word: string) => (title: string): boolean => plain(title).startsWith(word)
const isAsk = starts('決めること')
const isDecided = starts('決めたこと')
const isRemaining = starts('まだ決めていないこと')
const isClosing = starts('決めないまま閉じること')
const isPrAsk = starts('人が決めること')

/**
 * 1 件の issue / PR から、まだ決まっていない項目を拾う。
 *
 * - **open な issue**: 本文の「決めること」のうち、あとの「決めたこと」で番号を名指しされていないもの。
 *   「まだ決めていないこと」に番号が挙がっていれば、決まっていない側に戻す（あとに書かれたほうが勝つ）。
 *   番号を名指ししていない「まだ決めていないこと」の項目は、**いちばん新しいもの**をそのまま出す
 * - **閉じた issue**: 「決めないまま閉じること」があればそれだけ。無ければ、いちばん新しい「まだ決めていないこと」
 *   （番号を名指しされた本文の項目も）。それ以外の本文の「決めること」は出さない（閉じた issue の大半は、PR の仮置きのまま
 *   決まったものとして閉じている）
 * - **PR**: 本文の「人が決めること」を全部（PR には決めたことを書く場所が無いので、open な間は出す）
 */
export function pendingOf(src: DecisionSource): Pending[] {
  const base = { kind: src.kind, number: src.number, title: src.title, state: src.state }
  const make = (item: Item, from: Pending['from'], at: string, numbered = false): Pending => {
    const n = numbered ? item.n : undefined
    const recommend = recommendOf(item.whole)
    return { ...base, ...(n === undefined ? {} : { n }), from, text: clip(plain(item.head), DECISION_LINE_CHARS), date: localDate(at), ...(recommend ? { recommend } : {}) }
  }
  if (src.kind === 'pr') return sections(src.body, isPrAsk).flatMap((s) => listItems(s.lines).map((i) => make(i, 'pr', src.createdAt)))

  const docs = [{ body: src.body, createdAt: src.createdAt }, ...src.comments]
  /** 番号 → 決まったか（あとに書かれたほうが勝つ） */
  const decided = new Map<number, boolean>()
  let remaining: Pending[] | null = null
  let closing: Pending[] | null = null
  for (const doc of docs) {
    for (const s of sections(doc.body, isDecided)) {
      // 「決めたこと」の節から、中の「まだ決めていないこと」「決めないまま閉じること」を除いた文で、決まった番号を読む
      const inner = sections(s.lines.join('\n'), (t) => isRemaining(t) || isClosing(t))
      const skip = new Set(inner.flatMap((x) => x.lines))
      const text = [s.title, ...s.lines.filter((l) => !skip.has(l) && !HEADING.test(l))].join('\n')
      for (const n of namedNumbers(text)) decided.set(n, true)
    }
    for (const s of sections(doc.body, isRemaining)) {
      const items = listItems(s.lines)
      const loose: Pending[] = []
      for (const item of items) {
        const named = namedNumbers(item.whole)
        if (named.length) for (const n of named) decided.set(n, false)
        else loose.push(make(item, 'remaining', doc.createdAt))
      }
      remaining = loose
    }
    for (const s of sections(doc.body, isClosing)) closing = [...(closing ?? []), ...listItems(s.lines).map((i) => make(i, 'closing', doc.createdAt))]
  }
  const asked = sections(src.body, isAsk).flatMap((s) => listItems(s.lines))
  if (src.state === 'closed') {
    if (closing) return closing
    // 「まだ決めていないこと」で番号を名指しされた本文の項目は、閉じたあとも出す
    const named = asked.filter((i) => i.n !== undefined && decided.get(i.n) === false).map((i) => make(i, 'body', src.createdAt, true))
    return [...named, ...(remaining ?? [])]
  }
  const fromBody = asked.filter((i) => i.n === undefined || decided.get(i.n) !== true).map((i) => make(i, 'body', src.createdAt, true))
  return [...fromBody, ...(remaining ?? []), ...(closing ?? [])]
}

/** 何件かをまとめて。番号の新しい順（同じ番号の中は書かれた順のまま） */
export function pendingAll(sources: readonly DecisionSource[]): Pending[] {
  return [...sources].sort((a, b) => b.number - a.number).flatMap(pendingOf)
}

/** `gh issue list` / `gh pr list` の `--json` を読む。形の違うものは捨てる */
export function parseSources(stdout: string | null, kind: 'issue' | 'pr', state: 'open' | 'closed'): DecisionSource[] | null {
  if (stdout === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  const out: DecisionSource[] = []
  for (const it of raw as Record<string, unknown>[]) {
    if (!it || typeof it !== 'object' || !Number.isInteger(it.number)) continue
    const comments = Array.isArray(it.comments) ? (it.comments as Record<string, unknown>[]) : []
    out.push({
      kind,
      state,
      number: it.number as number,
      title: typeof it.title === 'string' ? it.title : '',
      body: typeof it.body === 'string' ? it.body : '',
      createdAt: typeof it.createdAt === 'string' ? it.createdAt : '',
      comments: comments
        .filter((c) => c && typeof c === 'object' && typeof c.body === 'string')
        .map((c) => ({ body: c.body as string, createdAt: typeof c.createdAt === 'string' ? c.createdAt : '' }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    })
  }
  return out
}
