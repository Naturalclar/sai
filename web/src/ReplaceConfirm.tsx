import type { ReplaceConfirm as Confirm } from './useReply'
import { showProcessOption } from './replyOptions.ts'

interface Props {
  confirm: Confirm
  /** フィードでは返信先のリポジトリを添える */
  repo?: string
  /** 打ちかけを C-u で消してから同じ本文を送る（kind が typed のときだけ出る） */
  onReplace: () => void
  /** 端末を見ずに別プロセス（claude -p --resume）で送る。端末には出ない */
  onProcess: () => void
  onCancel: () => void
}

/**
 * 端末に打ち込めなかったときの確認（#117、#157）。
 * - typed: 入力欄に打ちかけの文字がある。「消して送る」（C-u で消してから同じ本文）。Claude は別プロセスも選べる
 * - process: 消せなかった・ダイアログ中・入力欄が読めない。「別プロセスで送る」だけ
 * 別プロセスで送ると端末には出ず、端末で開いている会話はそのターンを知らない（README の注意）
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
          <button type="button" className={confirm.kind === 'typed' ? 'linkish' : 'primary'} onClick={onProcess} title="端末を見ずに claude -p --resume で 1 ターン回す。端末には出ず、端末で開いている会話はこのターンを知らない">
            別プロセスで送る
          </button>
        )}
        <button type="button" className="linkish" onClick={onCancel}>
          やめる
        </button>
      </div>
    </div>
  )
}
