import { projectName } from '../../shared/project.ts'
import { withSuffix } from '../../shared/sessionLabels.ts'
import { START_AGENT_LABEL } from '../../shared/startDraft.ts'
import type { StartDraftChoice } from './newSession'

interface Props {
  choices: readonly StartDraftChoice[]
  onPick: (choice: StartDraftChoice) => void
}

/** 「新しいセッション」のペインの頭に並べる、セッションが置いた案（#892）。選ぶと中身がフォームに入るだけで、まだ何も作らない */
export function StartDraftPicker({ choices, onPick }: Props) {
  if (choices.length === 0) return null
  return (
    <div className="start-drafts">
      <div className="field-label">セッションが置いた案</div>
      <ul>
        {choices.map((c) => (
          <li key={`start-draft:${c.from}`}>
            <span className="text">
              {withSuffix(c.session.meta?.name || c.session.title || c.session.id, c.session)}
              {c.session.project && <span className="where"> #{projectName(c.session.project)}</span>}: worktree「{c.draft.name}」で {START_AGENT_LABEL[c.draft.agent]}
            </span>
            <button type="button" onClick={() => onPick(c)}>
              この案で埋める
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
