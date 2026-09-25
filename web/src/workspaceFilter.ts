// 新しいセッションの画面（#314）で、worktree を打った文字で絞る（#489）。DOM に依存しないので workspaceFilter.test.ts を node:test で回す。
//
// **fuzzy**（飛び飛びの文字でも当たる。`saimin` → `Naturalclar/sai · dev-min`）。⌘K の `filterPalette()` /
// `shared/search.ts` の `matchesAll()` は「語ごとの部分一致」のままにしてある（あちらの当たり方は変えない）。
import { mergeHits } from '../../shared/search.ts'
import type { Hit } from '../../shared/search.ts'
import { workspaceLabel } from './newSession.ts'
import type { Workspace } from './newSession.ts'

export interface WorkspaceMatch {
  workspace: Workspace
  /** 画面に出す見出し（`workspaceLabel()`）と、その中で当たった場所 */
  label: string
  labelHits: Hit[]
  /** cwd の中で当たった場所 */
  cwdHits: Hit[]
}

/** 続けて当たった 1 文字ごと・語の頭で当たったときの加点 */
const RUN_BONUS = 2
const HEAD_BONUS = 3
const INNER_HEAD_BONUS = 1
/** 当たりの間に挟まった文字 1 つごとの減点（詰まって当たる方を上に） */
const GAP_PENALTY = 0.1
/** 前の方で当たったものを少しだけ上に */
const POSITION_PENALTY = 0.001

/** 1 文字（コードポイント）ずつに割った文字列。場所はこの単位で数える（絵文字で強調がずれないように） */
interface Chars {
  chars: string[]
  lower: string[]
}

const charsOf = (text: string): Chars => {
  const chars = Array.from(text)
  return { chars, lower: chars.map((c) => c.toLowerCase()) }
}

/** 語の頭か（先頭・英数字でない文字の直後・小文字から大文字に変わるところ） */
function isHead(chars: readonly string[], i: number): boolean {
  if (i === 0) return true
  const prev = chars[i - 1]!
  const here = chars[i]!
  if (!/[\p{L}\p{N}]/u.test(prev)) return true
  return prev === prev.toLowerCase() && here !== here.toLowerCase()
}

/**
 * 1 つの語を飛び飛びに当てる。当たらなければ null。最初の文字の出てくる場所ごとに残りを左から詰めて当て、
 * 一番点の高い並びを採る（`min` なら、`m…i…n` と散らばる場所より、続けて出てくる `min` を選ぶ）
 */
function matchWord({ chars, lower }: Chars, word: readonly string[]): { score: number; at: number[] } | null {
  let best: { score: number; at: number[] } | null = null
  for (let start = 0; start < lower.length; start++) {
    if (lower[start] !== word[0]) continue
    const at = [start]
    for (let i = start + 1, j = 1; j < word.length && i < lower.length; i++) {
      if (lower[i] === word[j]) {
        at.push(i)
        j++
      }
    }
    if (at.length < word.length) break // ここで当たらなければ、もっと後ろから始めても当たらない
    let score = word.length + (isHead(chars, start) ? HEAD_BONUS : 0) - start * POSITION_PENALTY
    for (let k = 1; k < at.length; k++) {
      const gap = at[k]! - at[k - 1]! - 1
      score += gap === 0 ? RUN_BONUS : (isHead(chars, at[k]!) ? INNER_HEAD_BONUS : 0) - gap * GAP_PENALTY
    }
    if (!best || score > best.score) best = { score, at }
  }
  return best
}

/** 1 文字ごとの場所を、文字列の場所（UTF-16）の強調にする */
const toHits = ({ chars }: Chars, at: readonly number[]): Hit[] =>
  mergeHits(at.map((p) => [chars.slice(0, p).join('').length, chars[p]!.length] as Hit))

/**
 * 打った文字で worktree を絞って、当たりの良い順に並べる。**空白で区切った語は全部当たるものだけ**（AND）。
 * 語は**見出しか cwd のどちらか一方の中で**当てる（またがせると、長い cwd と見出しの文字を拾い集めて何にでも当たる）。
 * 同じ点なら見出しの方で当て、並びは元の順（新しい順）のまま。何も打っていなければ全部をそのまま返す（強調も無し）
 */
export function filterWorkspaces(choices: readonly Workspace[], query: string): WorkspaceMatch[] {
  const words = query.trim().split(/\s+/).filter(Boolean).map((w) => Array.from(w.toLowerCase()))
  const scored: { match: WorkspaceMatch; score: number; order: number }[] = []
  choices.forEach((workspace, order) => {
    const label = workspaceLabel(workspace)
    const labelChars = charsOf(label)
    const cwdChars = charsOf(workspace.cwd)
    let score = 0
    const inLabel: number[] = []
    const inCwd: number[] = []
    for (const word of words) {
      const a = matchWord(labelChars, word)
      const b = matchWord(cwdChars, word)
      if (a && (!b || a.score >= b.score)) {
        score += a.score
        inLabel.push(...a.at)
      } else if (b) {
        score += b.score
        inCwd.push(...b.at)
      } else {
        return
      }
    }
    scored.push({ match: { workspace, label, labelHits: toHits(labelChars, inLabel), cwdHits: toHits(cwdChars, inCwd) }, score, order })
  })
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.match)
}
