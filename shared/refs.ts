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
  /**
   * 言い換える前の本文（#268）。**渡すと、ここに出てこない番号はリンクにしない**（文字のまま出す）。
   *
   * 一言を書くのは LLM なので、**本文に無い番号を書くことがある**（プロンプトの作例の `PR #12` を
   * そのまま写す、など）。番号は実在するのでリンク切れにもならず、押すと無関係の issue に飛ぶ。
   * 渡さなければ今までどおり全部リンクにする（後方互換）
   */
  source?: string
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

/**
 * 本文に出てくる参照（#268 の突き合わせ用）。**同じ regex で拾う**ので、本文の `#1234` を
 * 一言の `#123` の裏付けにしてしまう取りこぼしが無い（素朴な `includes('#123')` だと当たる）。
 *
 * `owner/repo#123` は**その owner/repo が remote と同じときだけ**裸の `#123` の裏付けにする。
 * 別のリポジトリの番号を、このリポジトリの番号として飛ばさないため。
 *
 * フィードのバブルに差分のボタンを出すか（#280。`web/src/feedDiff.ts`）も同じものを使う
 */
export function refsIn(source: string, remote: string | undefined): Set<string> {
  const found = new Set<string>()
  const re = new RegExp(REF.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    if (m[2]) {
      if (!m[1] || (remote && remote.endsWith(`/${m[1]}`))) found.add(`#${m[2]}`)
    } else if (m[3] && m[4]) found.add(`${m[3]}-${m[4]}`)
  }
  // **本文が URL で番号を出していることの方が多い**（手元の実データでは、裸の `#N` が無い番号 68 件のうち
  // 57 件が `…/issues/70` の形で本文に出ていた）。エージェントは URL を貼り、モデルがそれを `#70` と書く。
  // ここを見ないと、正しい参照のリンクまで外れる
  if (remote && GITHUB_REMOTE.test(remote)) {
    const escaped = remote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const url = new RegExp(`${escaped}/(?:issues|pull|discussions)/(\\d{1,9})`, 'g')
    for (const u of source.matchAll(url)) found.add(`#${u[1]}`)
  }
  return found
}

/** 素の文字列の中の参照だけをリンクにする（URL や Markdown の記号は見ない） */
function linkifyText(text: string, ctx: RefContext, known: Set<string> | null): Inline[] {
  const out: Inline[] = []
  const re = new RegExp(REF.source, 'g')
  // 本文を渡されていなければ何も絞らない（後方互換）
  const backed = (key: string) => known === null || known.has(key)
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    let href = ''
    if (m[2]) {
      // owner/repo#123 は向き先が本文に依らない（自分で行き先を名乗っている）ので、そのまま通す
      if (m[1]) href = `https://github.com/${m[1]}/issues/${m[2]}`
      else if (ctx.remote && GITHUB_REMOTE.test(ctx.remote) && backed(`#${m[2]}`)) href = `${ctx.remote}/issues/${m[2]}`
    } else if (m[3] && m[4] && ctx.linear && !NOT_LINEAR.has(m[3]) && backed(`${m[3]}-${m[4]}`)) {
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
function walk(nodes: Inline[], ctx: RefContext, known: Set<string> | null): Inline[] {
  const out: Inline[] = []
  for (const n of nodes) {
    if (n.kind === 'text') out.push(...linkifyText(n.text, ctx, known))
    else if (n.kind === 'strong') out.push({ kind: 'strong', children: walk(n.children, ctx, known) })
    else out.push(n)
  }
  return out
}

/**
 * 一言の 1 行を、URL・番号・Linear の識別子がリンクになった Inline の木にする。
 * まず Markdown の行内（URL、`code`、**太字**、[ラベル](URL)）に割り、その text ノードの中の参照だけを差し替える。
 * だから URL の途中の `#`（`/pull/12#issuecomment-…`）や `code` の中の `#123` は触らない。
 * `ctx.source`（言い換える前の本文）を渡すと、そこに無い番号はリンクにせず**文字のまま**残す（#268）
 */
export function linkifyRefs(text: string, ctx: RefContext = {}): Inline[] {
  return walk(parseInline(text), ctx, ctx.source === undefined ? null : refsIn(ctx.source, ctx.remote))
}

/** Linear の workspace として受け付ける形（URL の linear.app/<workspace>/ の部分）。空は「設定なし」 */
export function isLinearWorkspace(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || /^[a-z0-9][a-z0-9-]{0,63}$/.test(value))
}
