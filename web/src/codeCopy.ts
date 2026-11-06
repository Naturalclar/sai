// 返答のコードブロックのコピー（#877）。ボタンの見た目と、クリップボードに渡す文字列を決める。
// 書くのは `messageLink.ts` の `copyText()`（新しく作らない）。押したときだけ書き、読むことはしない
import type { Block } from '../../shared/markdown.ts'

/** ボタンの状態。`copied` / `failed` は押したあと少しの間だけ */
export type CodeCopyState = 'idle' | 'copied' | 'failed'

/** 「コピーしました」の印を出しておく長さ */
export const CODE_COPIED_MS = 1500

/**
 * クリップボードに渡す文字列。**描いたものと同じ `block.text` そのまま**（言語名・前後の ``` を含めない、
 * HTML にしない、何も足さない）
 */
export function codeCopyText(block: Extract<Block, { kind: 'code' }>): string {
  return block.text
}

/** ボタンの読み上げとホバーの文言。書けなかったときの案内（ブロックの下に出す）は `note` */
export function codeCopyView(state: CodeCopyState): { label: string; note: string } {
  switch (state) {
    case 'copied':
      return { label: 'コピーしました', note: '' }
    case 'failed':
      return { label: 'コードをコピー', note: 'コピーできません（選んでコピーしてください）' }
    case 'idle':
      return { label: 'コードをコピー', note: '' }
  }
}
