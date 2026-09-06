// 一言（digest）の中の参照をリンクにする。
//   #123 / PR #123 / issue #123 → <remote>/issues/123（remote が github.com のとき。issue でも PR でも /issues/<n> で正しい方へ飛ぶ）
//   owner/repo#123              → https://github.com/owner/repo/issues/123（remote に関係なく）
//   PGR-10891                   → https://linear.app/<workspace>/issue/PGR-10891（workspace が設定されているときだけ）
//   https://…                   → そのまま（Markdown と同じ切り方。parseInline に任せる）
// 出力は Markdown の Inline の木なので、描画は web/src/Inlines.tsx をそのまま使う。HTML 文字列は作らない。
// DOM 非依存なので shared/refs.test.ts を node:test で回す。
import { parseInline } from './markdown.ts'
import type { Inline } from './markdown.ts'

export interface RefContext {
  /** 行の remote（record.py が origin を https://host/owner/repo に正規化したもの）。無ければ #123 はリンクにしない */
  remote?: string
  /** Linear の workspace（URL の linear.app/<workspace>/ の部分）。空なら Linear の識別子はリンクにしない */
  linear?: string
}

const GITHUB_REMOTE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/

/**
 * `SHA-256` や `UTF-8` のような、Linear の識別子と同じ形の一般語。これは踏ませない。
 * `CVE-2024-1234` は後ろに `-` が続くので形の時点で外れる
 */
const NOT_LINEAR = new Set(['UTF', 'SHA', 'MD', 'RFC', 'ISO', 'ES', 'TLS', 'SSL', 'HTTP', 'IPV', 'GPT', 'AES', 'RSA', 'CRC', 'X', 'PS'])

// 1: owner/repo   2: #番号   3: Linear のチーム   4: Linear の番号
// `#` の直前が英数字や `&` `/` なら参照ではない（`&#123;`、`a#1`、URL の `/path#1`）。後ろに英数字や `-` が続くものも除く
const REF = /(?<![\w&/.-])(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d{1,9})(?![\w-])|(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,5})-(\d{1,6})(?![A-Za-z0-9-])/g

/** 素の文字列の中の参照だけをリンクにする（URL や Markdown の記号は見ない） */
function linkifyText(text: string, ctx: RefContext): Inline[] {
  const out: Inline[] = []
  const re = new RegExp(REF.source, 'g')
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    let href = ''
    if (m[2]) {
      if (m[1]) href = `https://github.com/${m[1]}/issues/${m[2]}`
      else if (ctx.remote && GITHUB_REMOTE.test(ctx.remote)) href = `${ctx.remote}/issues/${m[2]}`
    } else if (m[3] && m[4] && ctx.linear && !NOT_LINEAR.has(m[3])) {
      href = `https://linear.app/${ctx.linear}/issue/${m[3]}-${m[4]}`
    }
    if (!href) continue
    if (m.index > pos) out.push({ kind: 'text', text: text.slice(pos, m.index) })
    out.push({ kind: 'link', href, children: [{ kind: 'text', text: m[0] }] })
    pos = m.index + m[0].length
  }
  if (pos < text.length) out.push({ kind: 'text', text: text.slice(pos) })
  return out
}

/** Inline の木の text ノードだけを linkifyText に通す（code はそのまま、strong の中は再帰） */
function walk(nodes: Inline[], ctx: RefContext): Inline[] {
  const out: Inline[] = []
  for (const n of nodes) {
    if (n.kind === 'text') out.push(...linkifyText(n.text, ctx))
    else if (n.kind === 'strong') out.push({ kind: 'strong', children: walk(n.children, ctx) })
    else out.push(n)
  }
  return out
}

/**
 * 一言の 1 行を、URL・番号・Linear の識別子がリンクになった Inline の木にする。
 * まず Markdown の行内（URL、`code`、**太字**、[ラベル](URL)）に割り、その text ノードの中の参照だけを差し替える。
 * だから URL の途中の `#`（`/pull/12#issuecomment-…`）や `code` の中の `#123` は触らない
 */
export function linkifyRefs(text: string, ctx: RefContext = {}): Inline[] {
  return walk(parseInline(text), ctx)
}

/** Linear の workspace として受け付ける形（URL の linear.app/<workspace>/ の部分）。空は「設定なし」 */
export function isLinearWorkspace(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || /^[a-z0-9][a-z0-9-]{0,63}$/.test(value))
}
