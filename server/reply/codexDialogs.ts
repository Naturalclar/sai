// 通常起動された Codex TUI は app-server の JSON-RPC client ではないため、質問・許可の
// server request を SAI から購読できない。tmux の画面を低頻度で確認し、「人を待って止まっている」ことと、
// **何を聞かれているか**（#425。`parseCodexDialog()` が画面から読む選択肢）を見えるようにする。
// 回答は誤承認を避けるため端末に任せる（`answerable: false` のまま）。
import { createHash } from 'node:crypto'
import { codexDialogKey, codexDialogText } from '../../shared/codexDialog.ts'
import type { Approval, ApprovalMap, SessionSummary, Terminal } from '../../shared/types.ts'
import { inspectPrompt } from './terminal.ts'
import type { PsFn, Tmux } from './terminal.ts'

/**
 * 見に行く先。ふだんは行から作った一覧（`SessionSummary`）だが、**行がまだ 1 本も無いセッション**も
 * ペインから見つけて足せるようにしてある（#417。`app.ts` が組み立てる）
 */
export interface DialogTarget {
  id: string
  terminal: Terminal
}

export interface CodexDialogSource {
  scan(sessions: SessionSummary[], extra?: readonly DialogTarget[]): Promise<ApprovalMap>
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

  async scan(sessions: SessionSummary[], extra: readonly DialogTarget[] = []): Promise<ApprovalMap> {
    if (!this.scanning) {
      this.scanning = this.scanNow(sessions, extra).finally(() => {
        this.scanning = null
      })
    }
    await this.scanning
    return this.snapshot()
  }

  private async scanNow(sessions: SessionSummary[], extra: readonly DialogTarget[]): Promise<void> {
    const targets: DialogTarget[] = [
      ...sessions.filter((s) => s.agent === 'codex' && s.terminal).map((s) => ({ id: s.id, terminal: s.terminal! })),
      ...extra,
    ]
    const found = await Promise.all(
      targets.map(async (session): Promise<[string, Approval] | null> => {
        try {
          const state = await inspectPrompt(this.tmux, this.ps, session.terminal, 'codex')
          if (state.kind !== 'dialog') return null
          const dialog = state.dialog ?? null
          // **中身も id に混ぜる**（`approvalMapKey()` は approval_id しか見ないので、混ぜないと
          // 同じセッションで次の許可に変わったときに画面のポーリングが拾わない）。
          // 鍵にカーソルの位置は入らないので、矢印で選び直しただけでは待ち始めた時刻は戻らない
          const approvalId = `codex-dialog-${hash(session.id)}${dialog ? `-${hash(codexDialogKey(dialog))}` : ''}`
          const previous = this.active.get(session.id)
          const approval: Approval = {
            approval_id: approvalId,
            id: session.id,
            since: previous?.approval_id === approvalId ? previous.since : new Date(this.now()).toISOString(),
            tool_name: 'CodexDialog',
            input: {},
            tool_use_id: '',
            text: codexDialogText(dialog),
            agent: 'codex',
            answerable: false,
          }
          if (dialog) approval.dialog = dialog
          return [session.id, approval]
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

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

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
