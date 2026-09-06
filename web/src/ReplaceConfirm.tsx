import type { ReplaceConfirm as Confirm } from './useReply'

interface Props {
  confirm: Confirm
  /** フィードでは返信先のリポジトリを添える */
  repo?: string
  onReplace: () => void
  onCancel: () => void
}

/**
 * 端末の入力欄に打ちかけの文字があって送れなかったときの確認（#117）。
 * 「消して送る」で打ちかけを C-u で消してから同じ本文を送る。ダイアログ中はサーバがこれを出させない（code が違う）
 */
export function ReplaceConfirm({ confirm, repo, onReplace, onCancel }: Props) {
  return (
    <div className="notice confirm" role="alertdialog" aria-live="polite">
      <div>
        端末{repo ? `（#${repo}）` : ''}の入力欄に打ちかけの文字があります: <code>{confirm.typed || '（読めない）'}</code>
      </div>
      <div className="actions">
        これを消して、いまの返信を送りますか？
        <button type="button" className="primary" onClick={onReplace}>
          消して送る
        </button>
        <button type="button" className="linkish" onClick={onCancel}>
          やめる
        </button>
      </div>
    </div>
  )
}
