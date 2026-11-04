// ルールを作れない Bash の許可を、部品ごとに見て答える（#863）。
//
// Claude の「常に許可」のルールを組めない形の大半は、コマンドそのものではなく**つなぎ方**（`&&`・パイプ・ループ・`$( … )`）で、
// Claude Code は許されたコマンド同士でも、つなぐと聞き直してくる。ここでは**人がもう許したものを組み合わせても許す**だけにする:
//
// - 部品（単純なコマンド）に分けるのは `shared/bashRules.ts` の `splitComposed()`（`bashRulePlan()` と同じ分け方の 1 つ）
// - 部品が全部、次のどちらかであること
//   - そのセッションに効いている Claude の許可のルール（`allow`）に当たる。当てる形は `Bash` / `Bash(*)` / `Bash(<語>:*)` / `Bash(<語> *)` /
//     `Bash(<語>)`（完全一致）だけで、ほかの書き方（途中の `*` など）は当てない
//   - `notReadOnly()`（`shared/bashReadOnly.ts`）で読むだけと分かる。パイプの後ろの部品は、パイプの後ろとして同じ関数で見る
// - `ask` / `deny` のルールに当たりうる部品が 1 つでもあれば答えない（当てる形が分からない書き方のものは、全部に当たる扱い）
// - つなぎ方は、知っている安全な形だけを受ける: `&&`・`||`・`;`（改行）・`|`、文字の並びを回す `for`、部品が許されている `$( … )`、
//   捨てるだけのリダイレクト（`2>&1`・`>/dev/null` など。分け方が読み飛ばすもの）、そのセッションのリポジトリの中への `cd`
// - それ以外（ファイルに書くリダイレクト・ヒアドキュメント・代入・`$変数`・文字でない `for` の並び・サブシェル・リポジトリの外への `cd`・
//   知らない構文の語）は全部、人に回す。**拒否の一覧ではない**（知っている形だけを受け、分からなければ人に回す）
//
// 新しい許可は作らない（設定は読むだけ）。コマンドは実行しない。DOM に依存しないので bashComposed.test.ts を node:test で回す
import { isShellKeyword, isWrapperCommand, normalize, splitComposed, within } from './bashRules.ts'
import type { BashNoRuleReason } from './bashRules.ts'
import { notReadOnly } from './bashReadOnly.ts'
import type { NotReadOnly } from './bashReadOnly.ts'

/** 判定に使うもの。どれもサーバがセッションの行と設定から組む（リクエストからは受けない） */
export interface ComposedPlace {
  /** セッションの cwd（realpath。分からなければ空） */
  cwd: string
  /**
   * 行に書かれた cwd（realpath にする前の書き方）。`cwd` と違えば、`cd` の行き先のこの書き方で始まる所を `cwd` に読み替える
   * （macOS の `/var/…` と `/private/var/…` のように、コマンドは行の書き方で来る）。省略は読み替えない
   */
  written?: string
  /** そのセッションのリポジトリの worktree のトップ（#783。分からなければ空 = `cd` もファイルを読む部品も受けない） */
  roots: readonly string[]
  /** GitHub の `owner/repo`（`gh` が読んでよい先。分からなければ空） */
  repo: string
  /** ホーム（`cd ~/…` を読むため。分からなければ空） */
  home: string
  /** 効いている許可のルール（`allow`）の表記 */
  allow: readonly string[]
  /** 効いている `ask` と `deny` のルールの表記。当たりうる部品があれば答えない */
  block: readonly string[]
}

/** 受けなかったつなぎ方の種類。`shared/bashRules.ts` の理由に、ここで足す種類を加えたもの */
export type ComposedForm = BashNoRuleReason | 'assign' | 'for_form' | 'cd_join' | 'nested' | 'too_long'

/**
 * 判定の結果。`ok` のときは、部品ごとの根拠の数（`rule` = ルールに当たった、`read` = 読むだけと分かった）。
 * 通らないときは、つなぎ方（`form`）か部品（`part`。`notReadOnly()` の理由か、`ask` / `deny` に当たりうる `blocked`）のどちらか
 */
export type ComposedVerdict = { ok: true; rule: number; read: number } | { ok: false; form: ComposedForm } | { ok: false; part: NotReadOnly | 'blocked' }

/** これより長いコマンドは見ない（`notReadOnly()` の上限の数倍。長い本文は人が読む） */
export const COMPOSED_MAX_CHARS = 4000
/** `$( … )` と `for` を重ねてよい深さ */
const MAX_DEPTH = 4
/** `for` の並びに受ける語: 展開もグロブも空白も無い文字だけ（`-` で始まるものも、書いたとおりに渡るだけ） */
const LOOP_ITEM = /^[\w./:@%+,-]+$/
const LOOP_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

class Refused extends Error {
  readonly verdict: ComposedVerdict
  constructor(verdict: ComposedVerdict) {
    super('refused')
    this.verdict = verdict
  }
}
const refuseForm = (form: ComposedForm): never => {
  throw new Refused({ ok: false, form })
}
const refusePart = (part: NotReadOnly | 'blocked'): never => {
  throw new Refused({ ok: false, part })
}

/** ルールの表記の読み方。`all` は Bash の全部、`prefix` は語の前方一致、`exact` は完全一致、`unknown` は当てる形が分からない */
type RuleShape = { kind: 'all' } | { kind: 'prefix'; words: string[] } | { kind: 'exact'; words: string[] } | { kind: 'unknown' } | { kind: 'other' }

function ruleShape(rule: string): RuleShape {
  if (rule === 'Bash' || rule === 'Bash(*)') return { kind: 'all' }
  const m = /^Bash\((.*)\)$/s.exec(rule)
  if (!m) return { kind: 'other' }
  const body = m[1]!
  const head = /^(.*?)(?::\*| \*)$/s.exec(body)
  const text = head ? head[1]! : body
  // 語の区切りは空白 1 つだけ。語の中に `*`・引用符・タブ・改行などの書き方が残るものは、当てる形が分からない
  if (!text || /[*?[\]"'\\\t\n\r]| {2}/.test(text) || text !== text.trim()) return { kind: 'unknown' }
  const words = text.split(' ')
  return head ? { kind: 'prefix', words } : { kind: 'exact', words }
}

/** 部品の語が、その形のルールに当たるか。`opaque` は中身の分からない語（`$( … )`）の番号で、ルールの語にかかってはいけない */
function hits(shape: RuleShape, words: readonly string[], opaque: ReadonlySet<number>): boolean {
  if (shape.kind === 'all') return true
  if (shape.kind !== 'prefix' && shape.kind !== 'exact') return false
  if (shape.kind === 'exact' && (words.length !== shape.words.length || opaque.size > 0)) return false
  if (words.length < shape.words.length) return false
  return shape.words.every((w, n) => !opaque.has(n) && words[n] === w)
}

/** `ask` / `deny` に当たりうるか。当てる形が分からない Bash のルールは、全部に当たる扱い */
function blocked(words: readonly string[], block: readonly string[]): boolean {
  return block.some((rule) => {
    const shape = ruleShape(rule)
    if (shape.kind === 'other') return false
    if (shape.kind === 'unknown' || shape.kind === 'all') return true
    // 前方一致の判定は、中身の分からない語があっても字で比べる（当たりうる側に倒す）
    return shape.words.every((w, n) => words[n] === w) && (shape.kind === 'prefix' || words.length === shape.words.length)
  })
}

/**
 * `body` の中の `$名前` / `${名前}` を `value` に置き換える（`for` の中身）。一重引用符の中・バックスラッシュの次の字は置き換えない
 * （シェルも展開しない）。`value` は `LOOP_ITEM` の字だけなので、置き換えても語の切れ目は変わらない
 */
function substitute(body: string, name: string, value: string): string {
  let out = ''
  for (let k = 0; k < body.length; k++) {
    const c = body[k]!
    if (c === "'") {
      const end = body.indexOf("'", k + 1)
      const stop = end < 0 ? body.length : end + 1
      out += body.slice(k, stop)
      k = stop - 1
      continue
    }
    if (c === '\\') {
      out += body.slice(k, k + 2)
      k++
      continue
    }
    if (c === '$') {
      const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(body.slice(k))
      if (m && (m[1] ?? m[2]) === name) {
        out += value
        k += m[0].length - 1
        continue
      }
    }
    out += c
  }
  return out
}

interface Count {
  rule: number
  read: number
}

/** `cd` の行き先（語）を、いまの場所から読む。読めない形・リポジトリの外は断る */
function cdTarget(target: string | undefined, quoted: boolean, first: boolean, dir: string, place: ComposedPlace): string {
  if (!target || target.startsWith('-') || /[*?[]/.test(target) || target.includes('$')) return refuseForm('cd_form')
  let path = target
  if (path.startsWith('~')) {
    // `~` と `~/…` だけ、コマンドの最初の部品のときだけ（前で HOME が変わっていても見抜けない。`bashRulePlan()` と同じ線）
    if (!place.home || !first || quoted || (path !== '~' && !path.startsWith('~/'))) return refuseForm('cd_form')
    path = `${normalize(place.home)}${path.slice(1)}`
  }
  if (!dir) return refuseForm('cd_no_cwd')
  let next = normalize(path.startsWith('/') ? path : `${dir}/${path}`)
  const from = place.written?.startsWith('/') ? normalize(place.written) : ''
  const to = place.cwd.startsWith('/') ? normalize(place.cwd) : ''
  if (from && to && from !== to && within(next, from)) next = `${to}${next.slice(from.length)}`
  if (!place.roots.some((root) => root.startsWith('/') && within(next, normalize(root)))) return refuseForm('cd_outside')
  return next
}

/** コマンドの並びを読んで、部品ごとに確かめる。`top` は外側の並び（`cd` を受けるのはここだけ） */
function walk(command: string, dir: string, place: ComposedPlace, depth: number, top: boolean, count: Count): void {
  if (depth > MAX_DEPTH) refuseForm('nested')
  const split = splitComposed(command)
  if (typeof split === 'string') return refuseForm(split)
  const { parts, quoted, spans, ops, subs, vars } = split
  if (parts.length === 0) return refuseForm('empty')
  let here = dir
  for (let k = 0; k < parts.length; k++) {
    const words = parts[k]!
    const first = words[0]!
    const join = ops[k]!
    if (first === 'for') {
      // `for 名前 in 文字 …; do …; done` だけ。並びは展開の無い文字、中身は並びの語ごとに置き換えて読み直す
      const name = words[1]
      const items = words.slice(3)
      if (join === '|' || !name || !LOOP_NAME.test(name) || words[2] !== 'in' || vars.has(k) || subs.some((s) => s.part === k)) return refuseForm('for_form')
      if (items.some((w, n) => !LOOP_ITEM.test(w) || quoted.has(`${k}:${n + 3}`))) return refuseForm('for_form')
      const open = k + 1
      if (parts[open]?.[0] !== 'do' || ops[open] !== ';') return refuseForm('for_form')
      let close = -1
      for (let d = 0, n = open; n < parts.length; n++) {
        const w = parts[n]!
        if (n > open && w[0] === 'for') d++
        if (w.length === 1 && w[0] === 'done') {
          if (d === 0) {
            close = n
            break
          }
          d--
        }
      }
      if (close < 0 || ops[close] !== ';') return refuseForm('for_form')
      // `do` の語のすぐ後ろから、`done` の前まで
      const body = command.slice(spans[open]!.start + 2, spans[close]!.start)
      for (const item of items) walk(substitute(body, name, item), here, place, depth + 1, false, count)
      k = close
      continue
    }
    if (isShellKeyword(first)) return refuseForm('keyword')
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(first)) return refuseForm('assign')
    if (vars.has(k)) return refuseForm('expansion')
    const opaque = new Set(subs.filter((s) => s.part === k).map((s) => s.word))
    if (first === 'cd') {
      // 行き先が確かに変わってから次を走らせる形（`cd x && …`）だけ。`;` / `||` / `|` だと、`cd` に失敗した元の場所で次が走る
      const next = ops[k + 1]
      if (!top || join === '|' || words.length !== 2 || opaque.size > 0 || (next !== undefined && next !== '&&')) return refuseForm('cd_join')
      here = cdTarget(words[1], quoted.has(`${k}:1`), k === 0, here, place)
      continue
    }
    if (blocked(words, place.block)) return refusePart('blocked')
    const span = spans[k]!
    const text = command.slice(span.start, span.end).trim()
    const byRule = !isWrapperCommand(first) && place.allow.some((rule) => hits(ruleShape(rule), words, opaque))
    if (!byRule) {
      const why = notReadOnly(text, here, place.repo, place.roots, join === '|')
      if (why) return refusePart(why)
    }
    // `$( … )` の中身も部品ごとに確かめる（ルールで通した部品の中身は、ここで初めて見る）
    for (const sub of subs) if (sub.part === k) walk(sub.inner, here, place, depth + 1, false, count)
    if (byRule) count.rule++
    else count.read++
  }
}

/**
 * ルールを作れない Bash のコマンドを、部品ごとに見て答えてよいか（#863）。判定はこの 1 つ。
 * 部品が 1 つも無い（`cd` だけ）ものは答えない
 */
export function composedVerdict(command: string, place: ComposedPlace): ComposedVerdict {
  if (!command.trim()) return { ok: false, form: 'empty' }
  if (command.length > COMPOSED_MAX_CHARS) return { ok: false, form: 'too_long' }
  const count: Count = { rule: 0, read: 0 }
  try {
    walk(command, place.cwd.startsWith('/') ? normalize(place.cwd) : '', place, 0, true, count)
  } catch (err) {
    if (err instanceof Refused) return err.verdict
    return { ok: false, form: 'odd_command' }
  }
  if (count.rule + count.read === 0) return { ok: false, form: 'empty' }
  return { ok: true, ...count }
}
