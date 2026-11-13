// 新しい worktree と新しいセッションの「案」（#892 の段階 1。`sai_start`）。エージェントが名前・エージェント・最初の指示を置き、
// 人が要対応から「新しいセッション」を開いて押すと、今の画面の道（`POST /api/workspaces` → `POST /api/sessions/new`）で作られて始まる。
// **置くだけで、git もプロセスも起こさない**。ここは引数の検査と、出すかどうか（古さ）の判定だけの純粋関数
import { AGENT_TEXT_MAX_CHARS } from './agentMessages.ts'
import type { StartAgent, StartDraft } from './types.ts'
import { worktreeNameRefusal } from './worktreeName.ts'

/** エージェントに渡す道具の名前（`server/approvals/approve-mcp.ts` の `AGENT_TOOLS`） */
export const START_TOOL = 'sai_start'

/** 案を出しておく長さ。過ぎたら要対応から消える（置き場からも、次に置くときに捨てる） */
export const START_DRAFT_TTL_MS = 24 * 60 * 60 * 1000

/** 案に書けるエージェント（画面の「新しいセッション」で始められるものと同じ。#892 の「決めること」3） */
export const START_AGENTS: readonly StartAgent[] = ['claude', 'codex', 'opencode']

export const START_AGENT_LABEL: Record<StartAgent, string> = { claude: 'Claude Code', codex: 'Codex CLI', opencode: 'OpenCode' }

const isStartAgent = (v: unknown): v is StartAgent => typeof v === 'string' && (START_AGENTS as readonly string[]).includes(v)

/**
 * `sai_start` の引数を検査して、置く中身にする。**受けるのは名前・エージェント・最初の指示だけ**（パス・リポジトリ・ブランチ・base は
 * 受けない。置き場は置いたセッションの行の cwd から、押したときにサーバが組む）。名前は画面の worktree を作る口と同じ `worktreeNameRefusal()`。
 * 同じ名前の worktree が既にあるかは見ない（押したときに今の画面と同じく断る。#892 の「決めること」2）
 */
export function startDraftOf(args: { name?: unknown; agent?: unknown; text?: unknown }): { draft: Omit<StartDraft, 'at'> } | { error: string } {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const refusal = worktreeNameRefusal(name)
  if (refusal) return { error: `worktree の名前: ${refusal}` }
  const agent = args.agent === undefined || args.agent === '' ? 'claude' : args.agent
  if (!isStartAgent(agent)) return { error: `エージェントは ${START_AGENTS.join(' / ')} のどれかです` }
  const text = typeof args.text === 'string' ? args.text.trim() : ''
  if (!text) return { error: '最初の指示（text）が要ります' }
  if (text.length > AGENT_TEXT_MAX_CHARS) return { error: `最初の指示は ${AGENT_TEXT_MAX_CHARS} 字までです。短くまとめてください` }
  return { draft: { name, agent, text } }
}

/** 出してよい案か（置いてから `START_DRAFT_TTL_MS` 以内）。出さないなら undefined */
export function liveStartDraft(draft: StartDraft | undefined, now: number): StartDraft | undefined {
  if (!draft) return undefined
  return now - draft.at < START_DRAFT_TTL_MS ? draft : undefined
}

/** 要対応の 1 行 */
export function startDraftText(d: Pick<StartDraft, 'name' | 'agent'>): string {
  return `新しい worktree「${d.name}」で ${START_AGENT_LABEL[d.agent]} を始める案があります（開いて押すと作って始めます）`
}
