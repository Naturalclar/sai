// PR のコメント欄（#600）に出す短い言い換え。DOM に触らない純粋関数（prCommentLabels.test.ts）
import type { PrComment } from '../../shared/types.ts'

/** レビューの判定の印。会話のコメント・知らない値は null（何も出さない）。`tone` は色を分けるクラス名 */
export function reviewStateLabel(state: string | undefined): { label: string; tone: 'approved' | 'changes' | 'plain' } | null {
  if (state === 'APPROVED') return { label: '承認', tone: 'approved' }
  if (state === 'CHANGES_REQUESTED') return { label: '修正の依頼', tone: 'changes' }
  if (state === 'COMMENTED') return { label: 'レビュー', tone: 'plain' }
  if (state === 'DISMISSED') return { label: '取り下げられたレビュー', tone: 'plain' }
  return null
}

/** 畳んで出す理由。畳まないものは空 */
export function foldLabel(folded: PrComment['folded']): string {
  if (folded === 'minimized') return 'GitHub で畳まれています'
  if (folded === 'bot') return 'bot'
  return ''
}

/** 書いた人。消えたアカウントは GitHub と同じく ghost */
export function commentAuthor(author: string): string {
  return author || 'ghost'
}

/** 欄の見出し。落とした古いコメントがあれば数を添える */
export function commentsHeading(shown: number, omitted = 0): string {
  return omitted > 0 ? `コメント ${shown} 件（古い ${omitted} 件は出していません）` : `コメント ${shown} 件`
}
