import { SessionArchiveButton } from './SessionArchiveButton'
import { useArchive } from './useArchive'

/**
 * 要対応の下段（終わって次を待っている）の行から、もう続けないセッションを片付ける（#527）。
 * 中身はサイドバーと同じアーカイブ（記録は消さず、新しい行が届けば自動で戻る）。
 * 要対応はアーカイブ済みを出さないので、いま出ている行は必ずアーカイブされていない。成功すれば次のポーリングで行ごと消える
 */
export function TodoArchiveButton({ id }: { id: string }) {
  const archive = useArchive(id, false)
  return <SessionArchiveButton archive={archive} />
}
