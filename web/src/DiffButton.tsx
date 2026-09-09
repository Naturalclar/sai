import { IconButton } from './IconButton'
import { DiffMark } from './DiffMark'

/**
 * チャット見出しの「差分」。押したときにだけ git を読みに行く（ポーリングには乗せない）。
 * 出し方（広い画面は右のペイン、狭い画面はモーダル）は App が決めるので、ここは開く合図を送るだけ
 */
export function DiffButton({ onOpen }: { onOpen: () => void }) {
  return (
    <IconButton label="このセッションの差分を見る" onClick={onOpen}>
      <DiffMark />
    </IconButton>
  )
}
