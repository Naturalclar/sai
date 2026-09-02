// チャットのバブルに出す `text` を Markdown として描くための最小パーサ。
// 扱うのはエージェントの返答で頻出するものだけ:
//   URL / [ラベル](URL) / **太字** / `コード` / 箇条書き / 見出し / ```コードブロック / > 引用 / --- 罫線
// HTML 文字列は作らず木（Block / Inline）を返す。React 要素への組み立ては web/src/Markdown.tsx。
// `text` にはリポジトリの中身（issue のタイトルや他人のコミットメッセージ）がそのまま入るので、
// HTML として解釈させない（`<script>` はただの文字として text ノードになる）。
// 依存ゼロ・DOM 非依存なので node:test で回せる（shared/markdown.test.ts）。
// 一覧の1行表示（last_text）から記号だけ落とす stripMarkdown() も同じ字句解析を使う。

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }

export interface ListItem {
  /** 字下げの深さ（0 が最上位）。描画側でインデント量にする */
  depth: number
  /** 行頭の記号そのもの（`-` `*` `+` `1.` `2)` など） */
  marker: string
  /** 1行目と、記号なしで続いた行 */
  lines: Inline[][]
}

export type Block =
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; lines: Inline[][] }
  | { kind: 'rule' }

// 行内。左から一番早く始まるものを採る（同じ位置なら alternation の順）。
//   1: `コード`    2: **太字**（中身は空白で始まらず終わらない）
//   3: [ラベル](http(s) の URL)    4: むき出しの URL
// リンク先は http(s) だけ。`[file](web/src/x.ts)` のような相対パスや javascript: はリンクにしない。
// むき出しの URL は空白・<> のほか全角の句読点・閉じ括弧（、。）」など）の手前で終わる。日本語の文中に URL が置かれるため
const INLINE = /(`[^`\n]+`)|(\*\*\S(?:[^\n]*?\S)?\*\*)|(\[[^\]\n]*\]\(https?:\/\/[^\s)]*\))|(https?:\/\/[^\s<>、。，．）」』】〕》〉]+)/g

/** 1行分の行内要素。改行を含む文字列も受けるが、太字は行をまたがない */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  const re = new RegExp(INLINE.source, 'g')
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const whole = m[0]
    if (m.index > pos) out.push({ kind: 'text', text: src.slice(pos, m.index) })
    if (m[1]) {
      out.push({ kind: 'code', text: whole.slice(1, -1) })
    } else if (m[2]) {
      out.push({ kind: 'strong', children: parseInline(whole.slice(2, -2)) })
    } else if (m[3]) {
      const close = whole.indexOf('](')
      out.push({ kind: 'link', href: whole.slice(close + 2, -1), children: parseInline(whole.slice(1, close)) })
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

/** 字下げの幅から箇条書きの深さ。2〜4 スペースを1段と見なす（タブは 2 スペース扱い） */
const depthOf = (indent: string) => Math.min(Math.floor((indent.replace(/\t/g, '  ').length + 1) / 3), 5)

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
 * `**太字**` → 太字、`` `code` `` → code、`[ラベル](URL)` → ラベル、行頭の `- ` / `# ` / `> ` を除く。
 * むき出しの URL はそのまま残す。
 */
export function stripMarkdown(line: string): string {
  return plain(parseInline(line.replace(LEADING_MARK, '')))
}

function plain(nodes: Inline[]): string {
  return nodes.map((n) => (n.kind === 'text' || n.kind === 'code' ? n.text : plain(n.children))).join('')
}
