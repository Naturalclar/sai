// チャットのバブルに出す `text` を Markdown として描くための最小パーサ。
// 扱うのはエージェントの返答で頻出するものだけ:
//   URL / [ラベル](URL) / 画像 / **太字** / `コード` / :絵文字: / 箇条書き / 見出し / ```コードブロック / > 引用 / --- 罫線
// HTML 文字列は作らず木（Block / Inline）を返す。React 要素への組み立ては web/src/Markdown.tsx。
// `text` にはリポジトリの中身（issue のタイトルや他人のコミットメッセージ）がそのまま入るので、
// HTML として解釈させない（`<script>` はただの文字として text ノードになる）。
// 依存ゼロ・DOM 非依存なので node:test で回せる（shared/markdown.test.ts）。
// 一覧の1行表示（last_text）から記号だけ落とす stripMarkdown() も同じ字句解析を使う。
import { lookupEmoji } from './emoji.ts'

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  /** `:tada:` → 🎉。表（shared/emoji.ts）に載っている名前だけ。name は元の名前で、画面は title に出す */
  | { kind: 'emoji'; name: string; char: string }
  /**
   * 手元のファイルの画像への参照（#321）。`![alt](パス)` と、画像の拡張子の `[名前](パス)`（Codex はこの形で出す）。
   * `src` は本文に書かれたパスそのもの（絶対パスか、セッションの cwd からの相対パス）。`alt` は `[]` の中（空のこともある）
   */
  | { kind: 'image'; src: string; alt: string }

export interface ListItem {
  /** 字下げの深さ（0 が最上位）。描画側でインデント量にする */
  depth: number
  /** 行頭の記号そのもの（`-` `*` `+` `1.` `2)` など） */
  marker: string
  /** 1行目と、記号なしで続いた行 */
  lines: Inline[][]
}

/** 表の列の揃え（区切りの行の `:` の位置）。指定が無ければ null */
export type TableAlign = 'left' | 'center' | 'right' | null

export type Block =
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; lines: Inline[][] }
  | { kind: 'rule' }
  /** 表（#328）。`head` と `rows` の各行は列の数が `align` と同じ（足りないセルは空の配列） */
  | { kind: 'table'; align: TableAlign[]; head: Inline[][]; rows: Inline[][][] }

// 行内。左から一番早く始まるものを採る（同じ位置なら alternation の順）。
//   1: `コード`    2: **太字**（中身は空白で始まらず終わらない）
//   3: ![alt](先)    4: [名前](画像のファイルのパス)
//   5: [ラベル](http(s) の URL)    6: :絵文字:    7: むき出しの URL
// リンク先は http(s) だけ。`[file](web/src/x.ts)` のような相対パスや javascript: はリンクにしない。
// 画像は手元のパス（スキームの無いもの）で、拡張子が png / jpg / jpeg / gif / webp のものだけ（#321）。
// **外の URL の画像は読み込まない**（画面が外のホストに取りに行くと、見ていることが外に出る）ので、`![alt](https://…)` はリンクにする。
// むき出しの URL は空白・<> のほか全角の句読点・閉じ括弧（、。）」など）の手前で終わる。日本語の文中に URL が置かれるため。
// 絵文字は形が当たっただけでは採らず、表に載っている名前だけ（`14:08:30` の `:08:` のような時刻を絵文字にしないため）
const INLINE =
  /(`[^`\n]+`)|(\*\*\S(?:[^\n]*?\S)?\*\*)|(!\[[^\]\n]*\]\([^\s()]+\))|(\[[^\]\n]*\]\([^\s():]+\.(?:png|jpe?g|gif|webp|PNG|JPE?G|GIF|WEBP)\))|(\[[^\]\n]*\]\(https?:\/\/[^\s)]*\))|(:[a-z0-9_+-]{2,}:)|(https?:\/\/[^\s<>、。，．）」』】〕》〉]+)/g

/** 画像として扱う手元のパスか。スキーム（`:`）・空白・括弧を含まず、画像の拡張子で終わる */
const LOCAL_IMAGE = /^[^\s():]+\.(?:png|jpe?g|gif|webp)$/i

/** 画像のパスのファイル名（`alt` が空のときに出す名前） */
export const imageName = (src: string): string => src.split(/[\\/]/).pop() || src

/** `[ラベル](先)` の `[]` の中と `()` の中 */
function splitLink(whole: string): { label: string; target: string } {
  const close = whole.indexOf('](')
  return { label: whole.slice(whole.indexOf('[') + 1, close), target: whole.slice(close + 2, -1) }
}

/** 1行分の行内要素。改行を含む文字列も受けるが、太字は行をまたがない */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  const re = new RegExp(INLINE.source, 'g')
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const whole = m[0]
    // 表に無い名前はただの文字。開きの `:` の次から探し直す（`:foo::tada:` の後ろを拾うため）。
    // ここで抜けると pos を進めないので、この部分は後ろの text ノードに含まれる
    if (m[6] && !lookupEmoji(whole.slice(1, -1))) {
      re.lastIndex = m.index + 1
      continue
    }
    // `![alt](先)` で、先が手元の画像でも http(s) でもない（`notes.txt`、`file:`、`javascript:`）ものも同じくただの文字
    if (m[3]) {
      const { target } = splitLink(whole)
      if (!LOCAL_IMAGE.test(target) && !/^https?:\/\//.test(target)) {
        re.lastIndex = m.index + 1
        continue
      }
    }
    if (m.index > pos) out.push({ kind: 'text', text: src.slice(pos, m.index) })
    if (m[1]) {
      out.push({ kind: 'code', text: whole.slice(1, -1) })
    } else if (m[2]) {
      out.push({ kind: 'strong', children: parseInline(whole.slice(2, -2)) })
    } else if (m[3] || m[4]) {
      const { label, target } = splitLink(whole)
      if (LOCAL_IMAGE.test(target)) out.push({ kind: 'image', src: target, alt: label })
      // 外の URL の画像は読み込まずリンクにする。alt が空なら URL を出す
      else out.push({ kind: 'link', href: target, children: label ? parseInline(label) : [{ kind: 'text', text: target }] })
    } else if (m[5]) {
      const { label, target } = splitLink(whole)
      out.push({ kind: 'link', href: target, children: parseInline(label) })
    } else if (m[6]) {
      const name = whole.slice(1, -1)
      out.push({ kind: 'emoji', name, char: lookupEmoji(name)! })
    } else {
      // 文末の句読点や閉じ括弧は URL に含めない。`**https://...**` の閉じ `**` もここで外れる
      const href = trimUrl(whole)
      out.push({ kind: 'link', href, children: [{ kind: 'text', text: href }] })
      re.lastIndex = m.index + href.length
    }
    pos = re.lastIndex
  }
  if (pos < src.length) out.push({ kind: 'text', text: src.slice(pos) })
  return out
}

const URL_TRAIL = '.,;:!?\'"*_]>'

/** URL の末尾から句読点・装飾記号・対応の無い `)` を落とす。`wiki/Foo_(bar)` の `)` は残す */
function trimUrl(url: string): string {
  let end = url.length
  while (end > 0) {
    const c = url.charAt(end - 1)
    if (c === ')') {
      const head = url.slice(0, end)
      if (count(head, '(') >= count(head, ')')) break
      end--
    } else if (URL_TRAIL.includes(c)) {
      end--
    } else {
      break
    }
  }
  return url.slice(0, end)
}

const count = (s: string, ch: string) => s.split(ch).length - 1

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/
const BLANK = /^\s*$/

/** 行が `fence` で開いたコードブロックを閉じるか。同じ文字で開きと同じ長さ以上、他に何も無い行 */
function closesFence(line: string, fence: string): boolean {
  const m = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line)
  return !!m && m[1]!.charAt(0) === fence.charAt(0) && m[1]!.length >= fence.length
}

/**
 * 字下げの幅から箇条書きの深さ。2 スペース = 1 段（タブは 2 スペース扱い）。
 * `1. ` の下に 3 スペースで揃えた続きも 1 段に丸める（2 → 1、3 → 1、4 → 2、6 → 3）。深さは 5 で頭打ち
 */
const depthOf = (indent: string) => Math.min(Math.floor(indent.replace(/\t/g, '  ').length / 2), 5)

/**
 * 表の 1 行をセルに分ける（GFM）。外側の `|` を落とし、エスケープされていない `|` で分けて前後の空白を落とす。
 * `\|` は `|` に戻す（`` `…` `` の中でも同じ。エージェントは GitHub での見え方に合わせて書くので GitHub に揃える）
 */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i)
    if (ch === '\\' && s.charAt(i + 1) === '|') {
      cell += '|'
      i++
    } else if (ch === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell.trim())
  return cells
}

const DELIMITER_CELL = /^:?-+:?$/

/** 区切りの行（`| --- | :---: |`）ならその揃え。`|` の無い `---` は罫線なので表の区切りにしない */
function delimiterAlign(line: string | undefined): TableAlign[] | null {
  if (!line || !line.includes('|')) return null
  const cells = splitRow(line)
  if (!cells.every((cell) => DELIMITER_CELL.test(cell))) return null
  return cells.map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null
  })
}

/** 表の本文の続きになる行か。空行・`|` の無い行・別のブロック（コードブロック・見出し・引用・箇条書き）の始まりで終わる */
function isTableRow(line: string): boolean {
  return line.includes('|') && !BLANK.test(line) && !FENCE.test(line) && !HEADING.test(line) && !QUOTE.test(line) && !ITEM.test(line)
}

/** 表の見出しか。次の行が区切りの行で、**列の数が同じときだけ**（違えば今までどおり段落） */
function tableHead(line: string, next: string | undefined): { cells: string[]; align: TableAlign[] } | null {
  if (!isTableRow(line)) return null
  const align = delimiterAlign(next)
  if (!align) return null
  const cells = splitRow(line)
  return cells.length === align.length ? { cells, align } : null
}

/** 列の数を見出しに合わせる。足りなければ空のセルで埋め、多ければ切る（GFM と同じ） */
const fitCells = (cells: string[], n: number): string[] => Array.from({ length: n }, (_, i) => cells[i] ?? '')

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  // 次の行を吸い込めるブロック（段落・箇条書き・引用）。空行や別種のブロックで閉じる
  let open: Block | null = null
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    let m: RegExpExecArray | null

    if ((m = FENCE.exec(line))) {
      const fence = m[1]!
      const body: string[] = []
      i++
      while (i < lines.length && !closesFence(lines[i] ?? '', fence)) {
        body.push(lines[i] ?? '')
        i++
      }
      i++ // 閉じの行（無ければ EOF まで）
      blocks.push({ kind: 'code', lang: m[2] ?? '', text: body.join('\n') })
      open = null
      continue
    }
    if (BLANK.test(line)) {
      open = null
      i++
      continue
    }
    // 表（#328）。`|` を含む行の次が区切りの行で、列の数が同じとき。開いている段落の途中でも始める（GitHub と同じ）
    const head = tableHead(line, lines[i + 1])
    if (head) {
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && isTableRow(lines[i] ?? '')) {
        rows.push(fitCells(splitRow(lines[i] ?? ''), head.cells.length).map(parseInline))
        i++
      }
      blocks.push({ kind: 'table', align: head.align, head: head.cells.map(parseInline), rows })
      open = null
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      open = null
      i++
      continue
    }
    if ((m = HEADING.exec(line))) {
      blocks.push({ kind: 'heading', level: m[1]!.length, children: parseInline(m[2] ?? '') })
      open = null
      i++
      continue
    }
    if ((m = QUOTE.exec(line))) {
      const inline = parseInline(m[1] ?? '')
      if (open?.kind === 'quote') open.lines.push(inline)
      else blocks.push((open = { kind: 'quote', lines: [inline] }))
      i++
      continue
    }
    if ((m = ITEM.exec(line))) {
      const item: ListItem = { depth: depthOf(m[1] ?? ''), marker: m[2]!, lines: [parseInline(m[3] ?? '')] }
      if (open?.kind === 'list') open.items.push(item)
      else blocks.push((open = { kind: 'list', items: [item] }))
      i++
      continue
    }
    // 記号の無い行。箇条書きの直後なら最後の項目の続き、そうでなければ段落
    if (open?.kind === 'list') {
      open.items[open.items.length - 1]!.lines.push(parseInline(line.trim()))
    } else if (open?.kind === 'paragraph') {
      open.lines.push(parseInline(line))
    } else {
      blocks.push((open = { kind: 'paragraph', lines: [parseInline(line)] }))
    }
    i++
  }
  return blocks
}

const LEADING_MARK = /^\s{0,3}(?:#{1,6}\s+|>\s?|(?:[-*+]|\d{1,3}[.)])\s+)/

/**
 * 1行の文字列から Markdown の記号だけ落とす（一覧の last_text 用）。
 * `**太字**` → 太字、`` `code` `` → code、`[ラベル](URL)` → ラベル、画像 → 名前（無ければファイル名）、行頭の `- ` / `# ` / `> ` を除く。
 * むき出しの URL はそのまま残す。
 */
export function stripMarkdown(line: string): string {
  return plain(parseInline(line.replace(LEADING_MARK, '')))
}

function plain(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      if (n.kind === 'text' || n.kind === 'code') return n.text
      if (n.kind === 'emoji') return n.char
      if (n.kind === 'image') return n.alt || imageName(n.src)
      return plain(n.children)
    })
    .join('')
}
