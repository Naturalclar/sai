import { AGENT_LABEL } from './chatGroups'

export function AgentChip({ agent }: { agent: string }) {
  // 狭い画面では名前を隠して点だけにすることがある（要対応の行。#520）ので、名前は title にも持つ
  return (
    <span className="agent" title={AGENT_LABEL[agent] ?? agent}>
      <span className={`dot ${agent}`} />
      {AGENT_LABEL[agent] ?? agent}
    </span>
  )
}
