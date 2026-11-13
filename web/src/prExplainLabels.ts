// PR の解説（#881。`/brief-pr`）の欄の文言。描画は `PrExplainBox.tsx`
import type { PrExplain } from '../../shared/types.ts'

/** ボタンの文言。回している間は空（押せない） */
export function explainButtonLabel(explain: PrExplain | null): string {
  if (!explain) return '解説を作る'
  if (explain.state === 'running') return ''
  return explain.state === 'failed' ? 'もう一度作る' : '作り直す'
}

/** 欄に添える 1 行。無ければ空 */
export function explainNote(explain: PrExplain | null): string {
  if (!explain) return ''
  switch (explain.state) {
    case 'running':
      return '作っています（回しているセッションで進み具合を見られます。終わったら「更新」で読み直してください）'
    case 'ready':
      return explain.stale ? '古い解説です（作ったあとに push がありました）' : ''
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

/**
 * 解説のペイン（#887）で、HTML の代わりに出す 1 行。開けるとき（`ready` で鍵がある）は空。
 * まだ作っていない・作っている・消えた・見つからなかったは、作り直す道（PR の画面）を添える。`available` は PR の画面に作るボタンが出るか（`explain_available`）
 */
export function explainPaneEmpty(explain: PrExplain | null, available: boolean): string {
  if (explainOpenHref(explain)) return ''
  if (!explain) return available ? 'この PR の解説はまだありません。PR の画面の「解説を作る」から作れます' : 'この PR の解説はありません（このマシンでは作れません）'
  if (explain.state === 'running') return '作っています。終わったら「更新」で読み直してください'
  const why = explain.state === 'ready' ? '解説を開けません' : explainNote(explain)
  return available ? `${why}。PR の画面から作り直せます` : why
}

/** 開ける解説の開く先（`ready` で鍵があるとき）。開けなければ空。欄の「解説を開く」「ペインで開く」とペインの枠がこれ 1 つを見る */
export function explainOpenHref(explain: PrExplain | null): string {
  return explain?.state === 'ready' && explain.key ? explainHref(explain.key) : ''
}
