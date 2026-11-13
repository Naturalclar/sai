import { projectName } from '../../shared/project.ts'
import { withSuffix } from '../../shared/sessionLabels.ts'
import type { SiblingWorktree } from '../../shared/types.ts'
import type { StartDraftChoice } from './newSession'

interface Props {
  choice: StartDraftChoice
  /** 前に押して worktree だけできたもの（押し直しはこれで始める） */
  created: SiblingWorktree | null
  disabled: boolean
  /** 案を外して、ふつうの「新しいセッション」に戻る（案は残す） */
  onClear: () => void
  /** 案を捨てる（何も作らない） */
  onDiscard: () => void
}

/** 案で埋めたときの見出し（#892）。どこに何を作るかを書く。置き場は案を置いたセッションのリポジトリで、ここでは選べない */
export function StartDraftBanner({ choice, created, disabled, onClear, onDiscard }: Props) {
  const who = withSuffix(choice.session.meta?.name || choice.session.title || choice.session.id, choice.session)
  const where = projectName(choice.session.project) || choice.session.repo
  return (
    <div className="start-draft-banner">
      <div>
        「{who}」が置いた案: {created ? <>作った worktree「{created.repo}」で始める</> : <>{where ? `${where} に` : ''}新しい worktree「{choice.draft.name}」を作って始める</>}
      </div>
      <div className="draft-actions">
        <button type="button" disabled={disabled} onClick={onClear}>
          案を外す
        </button>
        <button type="button" disabled={disabled || created !== null} onClick={onDiscard}>
          捨てる
        </button>
      </div>
    </div>
  )
}
