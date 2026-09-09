import type { ReplaceConfirm as Confirm } from './useReply'
import { showProcessOption } from './replyOptions.ts'

interface Props {
  confirm: Confirm
  /** フィードでは返信先のリポジトリを添える */
  repo?: string
  /** 打ちかけを C-u で消してから同じ本文を送る（kind が typed のときだけ出る） */
  onReplace: () => void
  /** 端末を見ずに送る。Claude は別プロセス、開いている Codex は queue */
  onProcess: () => void
  onCancel: () => void
}

/**
 * 端末に打ち込めなかったときの確認（#117、#157）。
 * - typed: 入力欄に打ちかけの文字がある。「消して送る」と「端末を使わず送る」を選べる
 * - process: 消せなかった・ダイアログ中・入力欄が読めない。「端末を使わず送る」だけ
 */
export function ReplaceConfirm({ confirm, repo, onReplace, onProcess, onCancel }: Props) {
  const where = `端末${repo ? `（#${repo}）` : ''}`
  return (
    <div className="notice confirm" role="alertdialog" aria-live="polite">
      {confirm.kind === 'typed' ? (
        <div>
          {where}の入力欄に打ちかけの文字があります: <code>{confirm.typed || '（読めない）'}</code>
        </div>
      ) : (
        <div>{confirm.reason}</div>
      )}
      <div className="actions">
        {confirm.kind === 'typed' ? (
          <>
            これを消して、いまの返信を送りますか？
            <button type="button" className="primary" onClick={onReplace}>
              消して送る
            </button>
          </>
        ) : (
          '端末には打ち込めません。'
        )}
        {showProcessOption(confirm) && (
          <button type="button" className={confirm.kind === 'typed' ? 'linkish' : 'primary'} onClick={onProcess} title="端末を使わずに送る。Claude は別プロセスで再開し、開いている Codex は会話のキューへ追加する">
            端末を使わず送る
          </button>
        )}
        <button type="button" className="linkish" onClick={onCancel}>
          やめる
        </button>
      </div>
    </div>
  )
}
