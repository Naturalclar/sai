// Codex が許可の候補に入れてくる「規則の追加」（`acceptWithExecpolicyAmendment`。#741）を、ボタンに書ける範囲にする。
// 押すと Codex が自分の規則（`prefix_rule(pattern=[…], decision="allow")`）を足し、**セッションをまたいで残る**。
// SAI は規則を組まない・書かない（書くのは Codex）。ここは「何を今後聞かなくなるか」を人に見せる文を作り、
// 見せられない・広すぎる提案はボタンにしない、を決めるだけ。DOM にもプロセスにも触らないので node:test で回す。
import { SUBCOMMAND_CLIS } from './bashRules.ts'

/** ボタンに書く範囲の幅の上限（全角は 2）。全部は詳細の「実行規則の提案」に出ている */
export const AMENDMENT_LABEL_WIDTH = 48

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh'])
/** 中身を実行する側のコマンド。これ 1 語だけの規則は「何でも通す」に近い */
const RUNNERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'osascript', 'env', 'xargs', 'eval', 'exec', 'rm', 'curl', 'wget', 'ssh'])
/** 権限を上げる語。先頭に来る規則はボタンにしない */
const ELEVATORS = new Set(['sudo', 'doas'])

const base = (word: string): string => word.slice(word.lastIndexOf('/') + 1)

const width = (text: string): number => [...text].reduce((w, ch) => w + (ch.codePointAt(0)! >= 0x1100 ? 2 : 1), 0)

function clip(text: string, max: number): string {
  if (width(text) <= max) return text
  let out = ''
  let w = 0
  for (const ch of text) {
    w += ch.codePointAt(0)! >= 0x1100 ? 2 : 1
    // 末尾の `…` のぶん（幅 2 と数える）を空けておく
    if (w > max - 2) break
    out += ch
  }
  return `${out}…`
}

/**
 * 提案された規則（語の並び）の、人に見せる形。**ボタンにしないものは null**:
 * - 形が読めない（配列でない・空・文字列でない語・空の語）
 * - シェルだけ（`["/bin/zsh","-lc"]` のように、実行する中身が付いていない）
 * - 1 語だけで広すぎる（シェル・インタプリタ・`rm` など、サブコマンドを持つ CLI = `git` / `gh` / `pnpm` …）
 * - 権限を上げる語（`sudo` / `doas`）で始まる
 *
 * `text` はボタンに書く 1 行（シェルに包まれたもの `zsh -lc '<中身>'` は中身のほう。改行は空白にして幅で切る）
 */
export function amendmentScope(pattern: unknown): { text: string } | null {
  if (!Array.isArray(pattern) || pattern.length === 0) return null
  if (!pattern.every((word): word is string => typeof word === 'string' && word.trim() !== '')) return null
  const words = pattern as string[]
  const head = base(words[0]!)
  if (ELEVATORS.has(head)) return null
  const wrapped = SHELLS.has(head) && words.length >= 2 && /^-[a-z]*c$/.test(words[1]!)
  if (SHELLS.has(head) && (words.length < 3 || !wrapped)) return null
  if (words.length === 1 && (RUNNERS.has(head) || SUBCOMMAND_CLIS.has(head))) return null
  const shown = wrapped ? words.slice(2).join(' ') : words.map((word) => (/\s/.test(word) ? JSON.stringify(word) : word)).join(' ')
  const line = shown.replace(/\s+/g, ' ').trim()
  return line ? { text: clip(line, AMENDMENT_LABEL_WIDTH) } : null
}

/** ボタンの文言。「同種のコマンドを許可」とは書かない（提案は実測では「そのコマンドそのもの」で、押した範囲が見えることが要る） */
export function amendmentLabel(pattern: unknown): string | null {
  const scope = amendmentScope(pattern)
  return scope ? `「${scope.text}」を今後聞かない` : null
}
