// dots との会話ログの画面（#872）の小さな決まり。組み立て（返答を依頼に付ける・状態）は `shared/dots.ts`
import type { DotsConversation } from '../../shared/dots.ts'

/** 題名にする最初の投稿の長さ（字） */
const TITLE_MAX = 40

/**
 * 画面に並べる順。フィードと同じく**古いものが上、新しく動いたものが下**（入力欄のすぐ上に、いま続けている会話が来る）。
 * サーバは新しく動いた順で返すので、逆にする
 */
export function dotsTimeline(conversations: readonly DotsConversation[]): DotsConversation[] {
  return [...conversations].sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0))
}

/**
 * 会話の題名: dots が付けた会話の名前（取り込んだ会話。#878）があればそれ、無ければ最初の投稿の 1 行目を縮めたもの。
 * 投稿が無い（返答だけの）会話は「（題名なし）」
 */
export function dotsTitle(c: DotsConversation): string {
  const named = c.requests.find((r) => r.message.thread)?.message.thread
  const first = named ?? c.requests[0]?.message.text.split('\n').find((l) => l.trim())?.trim() ?? ''
  if (!first) return '（題名なし）'
  const chars = [...first]
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : first
}

/**
 * 入力欄の送り先。選んでいた会話が一覧に無ければ（まだ読めていない・消えた）新しい会話に落とす。
 * ただし送った直後で一覧がまだ追いついていない会話（`pending`）は残す
 */
export function dotsTarget(target: string | null, conversations: readonly DotsConversation[], pending: string | null): DotsConversation | string | null {
  if (target === null) return null
  const hit = conversations.find((c) => c.id === target)
  if (hit) return hit
  return target === pending ? target : null
}
