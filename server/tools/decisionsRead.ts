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

/** 見出しの行（3 字までの字下げは見出し）。終わりの空白と閉じの `#` は `heading()` が文字列として外す（正規表現で外すと、長い行で止まる） */
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/
/** 1 行がこれより長ければ見出しにも箇条書きにも見ない（本文は 65536 字まで 1 行に書ける） */
const LINE_MAX = 2000

function heading(line: string): { level: number; title: string } | null {
  if (line.length > LINE_MAX) return null
  const m = HEADING.exec(line)
  if (!m) return null
  let title = m[2]!.trimEnd()
  // 閉じの `#`（`## 題 ##`）
  let end = title.length
  while (end > 0 && title[end - 1] === '#') end--
  if (end < title.length && (end === 0 || title[end - 1] === ' ' || title[end - 1] === '\t')) title = title.slice(0, end).trimEnd()
  return { level: m[1]!.length, title }
}

/** `<!-- … -->` を消す（雛形の見出し・消したつもりの「決めたこと」を読まない）。閉じていなければ残りを全部消す */
function stripComments(markdown: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const open = markdown.indexOf('<!--', i)
    if (open < 0) return out + markdown.slice(i)
    out += markdown.slice(i, open)
    const close = markdown.indexOf('-->', open + 4)
    if (close < 0) return out
    // 行の数は保つ
    out += markdown.slice(open, close).replace(/[^\n]/g, '')
    i = close + 3
  }
}
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** コードブロックの開け閉めを追う。閉じるのは、開けたのと同じ字で、同じ長さ以上の行だけ（```` の中の ``` や ~~~ では閉じない） */
function fences(): (line: string) => boolean {
  let open = ''
  return (line) => {
    const m = FENCE.exec(line)
    if (!m) return open !== ''
    const mark = m[1]!
    if (!open) {
      // 同じ行で閉じているもの（行の頭に書いたインラインコード）は、コードブロックにしない
      if (mark[0] === '`' && line.slice(line.indexOf(mark) + mark.length).includes('`')) return false
      open = mark
    } else if (mark[0] === open[0] && mark.length >= open.length && !line.slice(line.indexOf(mark) + mark.length).trim()) open = ''
    return true
  }
}

/**
 * 見出しが `match` に当たる節を、出てきた順に返す。節は、同じか上の階層の見出しまで（下の階層の見出しは節の中）。
 * コードブロックの中の `#` は見出しにしない。当たった節の中の、当たる小見出しは節を分けない（同じ項目を 2 回数えない）
 */
export function sections(markdown: string, match: (title: string) => boolean): Section[] {
  const found: Section[] = []
  const open: Section[] = []
  const inCode = fences()
  for (const line of stripComments(markdown ?? '').split(/\r?\n/)) {
    const h = inCode(line) ? null : heading(line)
    if (h) {
      const level = h.level
      // 同じか上の階層の見出しで、開いている節を閉じる
      while (open.length && open[open.length - 1]!.level >= level) open.pop()
      for (const s of open) s.lines.push(line)
      if (!open.length && match(h.title)) {
        const s: Section = { title: h.title, level, lines: [] }
        found.push(s)
        open.push(s)
      }
      continue
    }
    for (const s of open) s.lines.push(line)
  }
  return found
}

const NUMBERED = /^( *)(\d{1,3})[.)]\s+(.*)$/
const BULLET = /^( *)[-*+]\s+(.*)$/
/** 「決めることは無い」と書いただけの行 */
const NOTHING = /^(?:\*\*)?(?:なし|無し|ない|ありません|特になし|特に無し|なし。|\(なし\)|（なし）|none|n\/a)(?:\*\*)?[。.]?$/i

/**
 * 節のいちばん上の階層の箇条書き（番号つき・点）を項目にする。いちばん上の階層は、節で最初に出た箇条書きの字下げ（3 字まで）で決める。
 * それより深い行・入れ子の箇条書きは、前の項目の続き。
 * 箇条書きが 1 つも無ければ、最初の段落の 1 行目を 1 項目にする（「なし」と書いただけなら 0 件）
 */
export function listItems(lines: readonly string[]): Item[] {
  const items: Item[] = []
  const inCode = fences()
  let cur: Item | null = null
  /** いちばん上の階層の字下げ。最初の箇条書きで決まる */
  let base = -1
  const loose: string[] = []
  for (const line of lines) {
    if (inCode(line)) continue
    // 節の中の小見出しは項目にしない（項目の続きにも入れない）
    if (heading(line)) {
      cur = null
      continue
    }
    const num = line.length > LINE_MAX ? null : NUMBERED.exec(line)
    const dot = num || line.length > LINE_MAX ? null : BULLET.exec(line)
    const indent = (num ?? dot)?.[1]!.length ?? 0
    if ((num || dot) && base < 0 && indent <= 3) base = indent
    if ((num || dot) && base >= 0 && indent <= base + 1) {
      const head = (num ? num[3]! : dot![2]!).trim()
      cur = { ...(num ? { n: Number(num[2]) } : {}), head, whole: head }
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

/** 番号の並び（`1・2`・`1, 3`・`1〜5`）。範囲は `〜` `~` `から` だけ（`2 - 8 色` を範囲と読まない） */
const NUMBER_LIST = String.raw`\d{1,3}(?:\s*(?:[・,、]|〜|~|から)\s*\d{1,3})*`

function expand(list: string, out: Set<number>): void {
  const parts = list.split(/\s*([・,、]|〜|~|から)\s*/)
  let prev: number | undefined
  for (let i = 0; i < parts.length; i += 2) {
    const n = Number(parts[i])
    const sep = i > 0 ? parts[i - 1]! : ''
    // 範囲（`1〜5`）は間も全部。広すぎる範囲は読み違いとして端だけ
    if (prev !== undefined && /^(?:〜|~|から)$/.test(sep) && n > prev && n - prev <= 50) for (let k = prev + 1; k < n; k++) out.add(k)
    out.add(n)
    prev = n
  }
}

/**
 * 文のどこかで触れている「決めること」の番号（`決めること 2`・`「決めること」1・2`・`決めること 1〜5`）。**決まっていない側に戻すときだけ**使う
 * （触れているだけで拾うので、決まったことの判定には使わない）
 */
export function mentionedNumbers(text: string): number[] {
  const out = new Set<number>()
  for (const m of half(text ?? '').matchAll(new RegExp(String.raw`決めること[」』]?\s*(${NUMBER_LIST})`, 'g'))) expand(m[1]!, out)
  return [...out].sort((a, b) => a - b)
}

/** 見出しで、番号の並びのすぐあとに来てよいもの: 閉じ括弧・`。`・行の終わり。`3 つのうち`・`2 はまだ`・`2: 保留`・`2、8 色` は名指しにしない */
const NAMED_END = String.raw`\s*(?:[）)。]|$)`

/**
 * 「決めたこと」の見出しの文で名指しされた番号（`決めたこと（2026-10-09。決めること 2）`・`（本文の「決めること」1・2）`）。
 * 番号の並びのすぐあとが閉じ括弧・`。`・行の終わりのものだけ。ほかの issue の「決めること」（`#12 の決めること 2`）は読まない
 */
export function namedInTitle(title: string): number[] {
  const out = new Set<number>()
  for (const m of half(title ?? '').matchAll(new RegExp(String.raw`(?<!#\d{1,7}\s?の\s?「?)決めること[」』]?\s*(${NUMBER_LIST})(?=${NAMED_END})`, 'g'))) expand(m[1]!, out)
  return [...out].sort((a, b) => a - b)
}

/**
 * 「決めたこと」の項目の頭で名指しされた番号（`決めること 2: 青にする`・`「決めること」1・3（案のとおり）`）。
 * **項目が「決めること N」で始まり、すぐあとが `:` か `（` か行の終わり**のものと、項目の終わりに番号だけを括弧で添えたもの（`…（決めること 3）`）だけ。
 * 文の途中で触れただけ（`…（決めること 2 が決まるまでの仮）`）・
 * `決めること 3 はまだ決めない` は、決まったと読まない
 */
export function namedAtHead(head: string): number[] {
  const out = new Set<number>()
  const text = half(plain(head ?? ''))
  const m = new RegExp(String.raw`^(?:本文の)?「?決めること[」』]?\s*(${NUMBER_LIST})(?=\s*(?:[:：（(]|$))`).exec(text)
  if (m) expand(m[1]!, out)
  // 項目の終わりに、番号だけを括弧で添えた形（`閾値は同じ値を使う（決めること 3）`）
  const tail = new RegExp(String.raw`[（(](?:本文の)?「?決めること[」』]?\s*(${NUMBER_LIST})[）)]\s*[。.]?$`).exec(text)
  if (tail) expand(tail[1]!, out)
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
  const before = text.slice(0, at)
  const opener = Math.max(before.lastIndexOf('（'), before.lastIndexOf('('))
  const closer = Math.max(before.lastIndexOf('）'), before.lastIndexOf(')'))
  // 括弧の中にある（開いて、まだ閉じていない）なら、その括弧の中だけ（`色の数（おすすめ: 8）` → `おすすめ: 8`）
  const inside = opener > closer
  // そうでなければ、その文の頭（前の `。` `、` か、閉じた括弧のあと）から、次の `。` まで
  const from = Math.max(before.lastIndexOf('。'), before.lastIndexOf('、'), inside ? opener : closer) + 1
  const end = text.indexOf('。', at)
  let sentence = text.slice(from, end < 0 ? undefined : end)
  if (inside) {
    // 開いた括弧に対応する閉じ括弧まで
    let depth = 0
    for (let i = 0; i < sentence.length; i++) {
      const c = sentence[i]!
      if (c === '（' || c === '(') depth++
      else if ((c === '）' || c === ')') && depth-- === 0) {
        sentence = sentence.slice(0, i)
        break
      }
    }
  }
  sentence = sentence.replace(/^[\s—–\-:：]+/, '').trim()
  // 括弧の中が「おすすめ」だけ（`青（おすすめ）か緑`）なら、括弧の前の語ごと（`青（おすすめ）`）
  if (inside && /^おすすめ[!！]?$/.test(sentence)) {
    const lead = before.slice(0, opener)
    const start = Math.max(lead.lastIndexOf('。'), lead.lastIndexOf('、'), lead.lastIndexOf(' '), lead.lastIndexOf('：'), lead.lastIndexOf(':')) + 1
    const word = lead.slice(start).trim()
    if (!word) return undefined
    sentence = `${word}（おすすめ）`
  }
  return sentence ? clip(sentence, DECISION_RECOMMEND_CHARS) : undefined
}

/** 見出しにせずに書いた「まだ決めていないこと」「決めないまま閉じること」の行（`**まだ決めていないこと**`・`- まだ決めていないこと:`） */
const NOT_YET = /^(?:[-*+]\s+|\d{1,3}[.)]\s+)?(?:まだ決めていないこと|決めないまま閉じること)/

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
 *   名指しと読むのは、「決めたこと」の見出しの文と、項目の頭の「決めること 2: …」だけ（`namedInTitle()` / `namedAtHead()`）。
 *   「まだ決めていないこと」で触れた番号は、決まっていない側に戻す（あとに書かれたほうが勝つ）。
 *   番号の無い「まだ決めていないこと」の項目は、**いちばん新しいコメントのもの**をそのまま出す
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
  const askedBy = sections(src.body, isAsk).map((s) => listItems(s.lines))
  const asked = askedBy.flat()
  /**
   * 本文の番号つきの項目のうち、突き合わせられるもの。同じ番号が 2 回出てくる（`1.` を並べた・節が 2 つある）ものと、
   * 続き番号になっていない節の番号（`1.` `3.` `4.` は、GitHub の表示では 1・2・3 になる）は入れない
   */
  const numbered = new Set<number>()
  const twice = new Set<number>()
  for (const items of askedBy) {
    const ns = items.flatMap((i) => (i.n === undefined ? [] : [i.n]))
    const sequential = ns.every((n, k) => n === ns[0]! + k)
    for (const n of ns) (numbered.has(n) || !sequential ? twice : numbered).add(n)
  }
  for (const n of twice) numbered.delete(n)
  /** 番号 → 決まったか（あとに書かれたほうが勝つ） */
  const decided = new Map<number, boolean>()
  let remaining: Pending[] | null = null
  let closing: Pending[] | null = null
  for (const doc of docs) {
    for (const s of sections(doc.body, isDecided)) {
      // 決まった番号を読むのは、「決めたこと」の見出しの文と、そのすぐ下（最初の小見出しまで）の項目の頭だけ。
      // 小見出しの下（「まだ決めていないこと」「次にやること」…）・引用・コードブロック・文の途中で触れた番号は読まない
      // 見出しにしていない「まだ決めていないこと」（太字の行・箇条書きの親）から下も読まない
      const sub = s.lines.findIndex((l) => heading(l) !== null || NOT_YET.test(plain(l)))
      const direct = sub < 0 ? s.lines : s.lines.slice(0, sub)
      for (const n of namedInTitle(s.title)) decided.set(n, true)
      for (const item of listItems(direct)) for (const n of namedAtHead(item.head)) decided.set(n, true)
    }
    // 番号の無い項目は、いちばん新しいコメントのものだけ（同じコメントの中に節が 2 つあれば足し合わせる）
    let loose: Pending[] | null = null
    for (const s of sections(doc.body, isRemaining)) {
      loose ??= []
      for (const item of listItems(s.lines)) {
        const named = mentionedNumbers(item.whole)
        for (const n of named) decided.set(n, false)
        // 本文の項目を指しているだけ（`決めること 3: …`・`…（決めること 3）`）で、その番号が本文に全部あるなら、本文の項目として出るので重ねない。
        // それ以外（文の途中で触れただけ・本文に無い番号）は、この項目もそのまま出す（出しすぎる側）
        const head = half(plain(item.head))
        const pointer = new RegExp(String.raw`^(?:本文の)?「?決めること[」』]?\s*${NUMBER_LIST}\s*(?:[:：（(]|$)|[（(](?:本文の)?「?決めること[」』]?\s*${NUMBER_LIST}[）)]\s*[。.]?$`).test(head)
        if (!(pointer && named.length && named.every((n) => numbered.has(n)))) loose.push(make(item, 'remaining', doc.createdAt))
      }
    }
    if (loose) remaining = loose
    for (const s of sections(doc.body, isClosing)) closing = [...(closing ?? []), ...listItems(s.lines).map((i) => make(i, 'closing', doc.createdAt))]
  }
  if (src.state === 'closed') {
    if (closing) return closing
    // 「まだ決めていないこと」で番号を名指しされた本文の項目は、閉じたあとも出す
    const named = asked.filter((i) => i.n !== undefined && decided.get(i.n) === false).map((i) => make(i, 'body', src.createdAt, true))
    return [...named, ...(remaining ?? [])]
  }
  const fromBody = asked.filter((i) => i.n === undefined || !numbered.has(i.n) || decided.get(i.n) !== true).map((i) => make(i, 'body', src.createdAt, true))
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
