import { AGENT_LABEL } from './api'

export function AgentChip({ agent }: { agent: string }) {
  return (
    <span className="agent">
      <span className={`dot ${agent}`} />
      {AGENT_LABEL[agent] ?? agent}
    </span>
  )
}

export function SynthTag() {
  return (
    <span className="tag synth" title="セッションIDが取れず、時間で合成">
      合成
    </span>
  )
}
