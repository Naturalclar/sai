import { AGENT_LABEL } from './api'

export function AgentChip({ agent }: { agent: string }) {
  return (
    <span className="agent">
      <span className={`dot ${agent}`} />
      {AGENT_LABEL[agent] ?? agent}
    </span>
  )
}
