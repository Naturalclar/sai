// PR の解説（#881。`/brief-pr`）の欄の文言。描画は `PrExplainBox.tsx`
import type { PrExplain } from '../../shared/types.ts'

/** 回している間に状態を見に行く間隔 */
export const EXPLAIN_POLL_MS = 5000

/** 回したときから head が進んだか（状態だけの GET は head を知らないので、画面のいまの head と比べる） */
export function explainStale(explain: PrExplain, head: string): boolean {
  return explain.stale || (!!head && !!explain.head_sha && explain.head_sha !== head)
}

/** ボタンの文言。回している間は空（押せない） */
export function explainButtonLabel(explain: PrExplain | null): string {
  if (!explain) return '解説を作る'
  if (explain.state === 'running') return ''
  return explain.state === 'failed' ? 'もう一度作る' : '作り直す'
}

/** 欄に添える 1 行。無ければ空 */
export function explainNote(explain: PrExplain | null, head: string): string {
  if (!explain) return ''
  switch (explain.state) {
    case 'running':
      return '作っています（裏で /brief-pr を回しています。数分かかります）'
    case 'ready':
      return explainStale(explain, head) ? '古い解説です（作ったあとに push がありました）' : ''
    case 'gone':
      return '解説はもうありません（一時フォルダから消えました）'
    case 'failed':
      return '解説の HTML が見つかりませんでした（回したセッションで理由を見られます）'
  }
}

/** 開く先。SAI の口なので tailnet 越しの画面からもそのまま開ける */
export function explainHref(key: string): string {
  return `/api/pr-explain/${encodeURIComponent(key)}`
}
