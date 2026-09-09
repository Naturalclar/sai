// 通常起動された Codex TUI は app-server の JSON-RPC client ではないため、質問・許可の
// server request を SAI から購読できない。tmux の画面を低頻度で確認し、少なくとも
// 「人を待って止まっている」ことを見えるようにする。回答は誤承認を避けるため端末に任せる。
import { createHash } from 'node:crypto'
import type { Approval, ApprovalMap, SessionSummary } from '../shared/types.ts'
import { inspectPrompt } from './terminal.ts'
import type { PsFn, Tmux } from './terminal.ts'

export interface CodexDialogSource {
  scan(sessions: SessionSummary[]): Promise<ApprovalMap>
}

export class CodexDialogs implements CodexDialogSource {
  private active = new Map<string, Approval>()
  private scanning: Promise<void> | null = null
  private readonly tmux: Tmux
  private readonly ps: PsFn
  private readonly now: () => number

  constructor(tmux: Tmux, ps: PsFn, now: () => number = Date.now) {
    this.tmux = tmux
    this.ps = ps
    this.now = now
  }

  async scan(sessions: SessionSummary[]): Promise<ApprovalMap> {
    if (!this.scanning) {
      this.scanning = this.scanNow(sessions).finally(() => {
        this.scanning = null
      })
    }
    await this.scanning
    return this.snapshot()
  }

  private async scanNow(sessions: SessionSummary[]): Promise<void> {
    const targets = sessions.filter((s) => s.agent === 'codex' && s.terminal)
    const found = await Promise.all(
      targets.map(async (session): Promise<[string, Approval] | null> => {
        try {
          const state = await inspectPrompt(this.tmux, this.ps, session.terminal!, 'codex')
          if (state.kind !== 'dialog') return null
          const previous = this.active.get(session.id)
          return [
            session.id,
            previous ?? {
              approval_id: `codex-dialog-${createHash('sha256').update(session.id).digest('hex').slice(0, 16)}`,
              id: session.id,
              since: new Date(this.now()).toISOString(),
              tool_name: 'CodexDialog',
              input: {},
              tool_use_id: '',
              text: 'Codex の画面で質問または許可への回答を待っている',
              agent: 'codex',
              answerable: false,
            },
          ]
        } catch {
          // ペイン消滅、pid 不一致、capture 失敗は「待機している」と断定しない。
          return null
        }
      }),
    )
    this.active = new Map(found.filter((entry): entry is [string, Approval] => entry !== null))
  }

  private snapshot(): ApprovalMap {
    return Object.fromEntries(Array.from(this.active, ([id, approval]) => [id, [approval]]))
  }
}

/** Claude の構造化 Approval と Codex TUI の検出専用表示を同じ API の形へ重ねる。 */
export function mergeApprovalMaps(...maps: ApprovalMap[]): ApprovalMap {
  const out: ApprovalMap = {}
  for (const map of maps) {
    for (const [id, entries] of Object.entries(map)) (out[id] ??= []).push(...entries)
  }
  for (const entries of Object.values(out)) entries.sort((a, b) => a.since.localeCompare(b.since))
  return out
}

/** rev に混ぜる安定した鍵。検出・解消のどちらでも画面のポーリングが更新される。 */
export function approvalMapKey(map: ApprovalMap): string {
  return Object.values(map)
    .flat()
    .map((approval) => approval.approval_id)
    .sort()
    .join(',')
}
