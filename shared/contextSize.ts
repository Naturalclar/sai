// セッションのいまのコンテキスト量（#441）。返信 1 回ごとにこの量を読み直すので、大きくなったら切り替えどき。
// 値は `ProgressReader.read()` の `context_tokens`（Claude は transcript の入力 3 つの和、Codex は rollout の last_token_usage、OpenCode は本体）。
// 画面の見出しと印（`web/src/headTags.ts`）が同じ区切りを見る

/** これ以上なら見出しに警告の印を出す（仮。#441） */
export const CONTEXT_WARN_TOKENS = 400_000

/** 閾値を超えているか。0（分からない）は超えていない */
export function contextWarns(tokens: number | undefined): boolean {
  return (tokens ?? 0) >= CONTEXT_WARN_TOKENS
}

/** `830k` / `1.2M` の形。1000 未満はそのまま、0（分からない）は空 */
export function contextLabel(tokens: number | undefined): string {
  const t = tokens ?? 0
  if (!(t > 0)) return ''
  if (t < 1000) return String(Math.round(t))
  if (t < 1_000_000) return `${Math.round(t / 1000)}k`
  return `${(Math.floor(t / 100_000) / 10).toFixed(1)}M`
}

/** 見出しの title。返信のたびに読み直す量だと分かるように */
export function contextTitle(tokens: number): string {
  const warn = contextWarns(tokens) ? `\n${contextLabel(CONTEXT_WARN_TOKENS)} を超えています。新しいセッションに切り替えどきかもしれません` : ''
  return `いまのコンテキスト: ${tokens.toLocaleString('ja-JP')} トークン\n返信 1 回でこの量を読み直します${warn}`
}

/**
 * 詳細の rev に混ぜる値。ターンの途中は手順ごとに少しずつ増えるので、そのたびにチャットを描き直さないよう 1 万で丸める。
 * 警告の境目をまたいだら必ず変わる
 */
export function contextRevKey(tokens: number): string {
  return `${Math.floor(tokens / 10_000)}${contextWarns(tokens) ? '!' : ''}`
}
