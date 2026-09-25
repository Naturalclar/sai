// 通常起動された Codex TUI は app-server の JSON-RPC client ではないため、質問・許可の
// server request を SAI から購読できない。tmux の画面を低頻度で確認し、「人を待って止まっている」ことと、
// **何を聞かれているか**（#425。`parseCodexDialog()` が画面から読む選択肢）を見えるようにする。
// **答えるのも画面からできる**（#450）: 押された選択肢まで印（`›`）を矢印で動かして `Enter` を送る。
// 実機（codex 0.154.0）で測ったところ、**数字キーは効かず**（`1` を送っても動かない）、
// **矢印で動かして `Enter`** か **ラベルの近道キー（`y`）** が効いた。近道キーはラベルの読み方に依るので使わず、
// どのダイアログでも同じ「動かして確かめて Enter」に揃える。
//
// **誤承認を避ける歯止めは 3 つ**（#208 の懸念はキーが効くかではなく、読んでから送るまでに画面が変わること）:
// 1. 送る前にもう一度読み、**同じダイアログか**（`codexDialogKey()`。カーソルの位置は含まない）を確かめる
// 2. 動かしたあとにもう一度読み、**印が狙った選択肢に来たか**を確かめてから `Enter`
// 3. `Enter` のあとにもう一度読み、**そのダイアログが消えたか**を確かめる。残っていれば「送れなかった」と返す（押し直さない）
import { createHash } from 'node:crypto'
import { codexDialogKey, codexDialogText, dialogDecisionIndex, dialogDecisions, dialogSteps, selectedIndex } from '../../shared/codexDialog.ts'
import type { Approval, ApprovalAnswer, ApprovalMap, SessionSummary, Terminal, TerminalDialog } from '../../shared/types.ts'
import { inspectPrompt } from './terminal.ts'
import type { PsFn, Tmux } from './terminal.ts'

/** 答えた結果。`codexAppServer.ts` の `CodexAnswerResult` と同じ形にして、app.ts の分岐を揃える */
export type DialogAnswerResult = { ok: true } | { ok: false; status: number; error: string }

/** キーを送ってから画面が描き直るのを待つ既定（`terminal.ts` の `SETTLE_MS` と同じ）。テストは 0 */
const SETTLE_MS = 150

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
  /** その approval_id が端末のダイアログか（#450。app.ts の分岐用）。偽物は持たなくてよい */
  has?(approvalId: string): boolean
  /** 前回の走査で見えていたダイアログ（ペインを見に行かない。#495 の締切で使う）。偽物は持たなくてよい */
  snapshot?(): ApprovalMap
  /** 画面から押された選択をペインに送る（#450）。偽物は持たなくてよい（持たなければ答えられないまま） */
  answer?(approvalId: string, answer: ApprovalAnswer): Promise<DialogAnswerResult>
}

export class CodexDialogs implements CodexDialogSource {
  private active = new Map<string, Approval>()
  private scanning: Promise<void> | null = null
  private readonly tmux: Tmux
  private readonly ps: PsFn
  private readonly now: () => number
  private readonly settleMs: number
  /** 見に行く先（`answer()` がペインを引くのに使う）。`scan()` のたびに入れ替える */
  private targets = new Map<string, Terminal>()

  constructor(tmux: Tmux, ps: PsFn, now: () => number = Date.now, settleMs: number = SETTLE_MS) {
    this.tmux = tmux
    this.ps = ps
    this.now = now
    this.settleMs = settleMs
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
            // 中身が読めているときだけ答えられる（読めていなければ今までどおり端末で。#450）
            answerable: dialog !== null,
          }
          if (dialog) {
            approval.dialog = dialog
            approval.decisions = dialogDecisions(dialog)
          }
          return [session.id, approval]
        } catch {
          // ペイン消滅、pid 不一致、capture 失敗は「待機している」と断定しない。
          return null
        }
      }),
    )
    this.active = new Map(found.filter((entry): entry is [string, Approval] => entry !== null))
    this.targets = new Map(targets.map((t) => [t.id, t.terminal]))
  }

  /** その approval_id が、いま出ている端末のダイアログか（#450） */
  has(approvalId: string): boolean {
    return [...this.active.values()].some((a) => a.approval_id === approvalId)
  }

  /**
   * 押された選択をペインに送る（#450）。**送る前・動かしたあと・送ったあと**の 3 回読み直す。
   * 1 つでも食い違えば送らずに `409`（そのまま端末で答えられる）
   */
  async answer(approvalId: string, answer: ApprovalAnswer): Promise<DialogAnswerResult> {
    const entry = [...this.active.entries()].find(([, a]) => a.approval_id === approvalId)
    if (!entry) return { ok: false, status: 404, error: 'approval not found' }
    const [id, approval] = entry
    const terminal = this.targets.get(id)
    const shown = approval.dialog ?? null
    if (!terminal || !shown) return { ok: false, status: 409, error: 'この待ちは端末で答えてください' }
    const index = dialogDecisionIndex(shown, answer.decision, answer.behavior)
    if (index === null) return { ok: false, status: 400, error: '提示されていない選択です' }

    // 1. 送る前: いまも同じダイアログか（人が端末で答えた・別の許可に入れ替わった直後に押さない）
    const before = await this.dialogNow(terminal)
    if (!before || codexDialogKey(before) !== codexDialogKey(shown)) {
      return { ok: false, status: 409, error: '画面が変わりました（もう一度確かめてください）' }
    }
    // 2. 印を動かす → 狙った選択肢に来たかを読み返してから Enter
    const steps = dialogSteps(before, index)
    if (!steps) return { ok: false, status: 409, error: 'いまどれが選ばれているか読めません' }
    let aimed = before
    if (steps.count > 0) {
      await this.tmux.run(['send-keys', '-t', terminal.pane, ...Array.from({ length: steps.count }, () => steps.key)])
      await this.wait()
      const moved = await this.dialogNow(terminal)
      if (!moved || codexDialogKey(moved) !== codexDialogKey(shown) || selectedIndex(moved) !== index) {
        return { ok: false, status: 409, error: '選び直せませんでした（端末で答えてください）' }
      }
      aimed = moved
    } else if (selectedIndex(before) !== index) {
      return { ok: false, status: 409, error: 'いまどれが選ばれているか読めません' }
    }
    // 3. 確定して、そのダイアログが消えたことを確かめる（消えていなければ押し直さない）
    await this.tmux.run(['send-keys', '-t', terminal.pane, 'Enter'])
    await this.wait()
    const after = await this.dialogNow(terminal)
    if (after && codexDialogKey(after) === codexDialogKey(aimed)) {
      return { ok: false, status: 409, error: '答えが届きませんでした（端末で答えてください）' }
    }
    this.active.delete(id)
    return { ok: true }
  }

  /** いまそのペインに出ているダイアログ。ダイアログでない・読めない・ペインが消えたときは null */
  private async dialogNow(terminal: Terminal): Promise<TerminalDialog | null> {
    try {
      const state = await inspectPrompt(this.tmux, this.ps, terminal, 'codex')
      return state.kind === 'dialog' ? (state.dialog ?? null) : null
    } catch {
      return null
    }
  }

  private wait(): Promise<void> {
    return this.settleMs > 0 ? new Promise((r) => setTimeout(r, this.settleMs)) : Promise.resolve()
  }

  snapshot(): ApprovalMap {
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

/** rev に混ぜる安定した鍵。検出・解消のどちらでも、Jev の確率が届いたときも（#491）画面のポーリングが更新される。 */
export function approvalMapKey(map: ApprovalMap): string {
  return Object.values(map)
    .flat()
    .map((approval) => (approval.jev === undefined ? approval.approval_id : `${approval.approval_id}:${approval.jev}`))
    .sort()
    .join(',')
}
