// ファイルビューア（#603）の、DOM に触らない部分（fileView.test.ts）。
import type { FileRef } from '../../shared/files.ts'

/** 1 行の高さ（px）。行番号・本文・飛び先の印が同じ値を使う（CSS の `--file-line-h` と揃える） */
export const FILE_LINE_H = 18

export type FileMode = 'rendered' | 'raw'

/** Markdown として描けるファイルか（拡張子で見る） */
export function isMarkdownFile(name: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(name)
}

/**
 * 開いたときの出し方。Markdown は描いた形、ほかは元の文字。**行を指して開いたときは Markdown でも元の文字**
 * （描いた形には行番号が無く、指した行に飛べない）
 */
export function initialMode(ref: FileRef): FileMode {
  return isMarkdownFile(ref.path) && !ref.line ? 'rendered' : 'raw'
}

/** 行に分ける。最後の改行のあとの空の行は数えない（エディタの行数と合わせる）。空のファイルは 1 行 */
export function fileLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/** 行番号の列（`1\n2\n…`）。行ごとに要素を作らず、1 つの文字列で出す */
export function lineNumbers(count: number): string {
  let out = ''
  for (let i = 1; i <= count; i++) out += i === 1 ? '1' : `\n${i}`
  return out
}

/** 飛び先の行。指定が無い・範囲の外は 0（飛ばない・印も出さない） */
export function targetLine(line: number, count: number): number {
  return line >= 1 && line <= count ? line : 0
}

/** その行が真ん中より少し上に来るスクロール位置 */
export function scrollTopFor(line: number, viewHeight: number): number {
  return Math.max(0, (line - 1) * FILE_LINE_H - Math.floor(viewHeight / 3))
}

/** 大きさ（`12KB` / `1.2MB` / `300B`） */
export function fileSizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}
