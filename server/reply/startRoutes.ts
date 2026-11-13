// 新しい worktree と新しいセッションの案（#892 の段階 1。`sai_start`）の口。`createApp()`（app.ts）から外に出した区分（#807 の形）。
// - `POST /api/agent/start`: エージェント（SAI が起こしていま回しているターン）が、名前・エージェント・最初の指示を置く。**置くだけで git もプロセスも起こさない**
// - `POST /api/sessions/<id>/start-draft`: 人が画面で片付ける（始めた・捨てた）。同一オリジンのみ
// 作って始めるのは、人が押したときの今の画面の道（`POST /api/workspaces` → `POST /api/sessions/new`）だけ。段階 2（直接始める）は作らない
import { appendFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { splitHandedReplies } from '../../shared/agentMessages.ts'
import { modeName, modeSkipsRules, replyModeOf, skipModeInArgs } from '../../shared/permissions.ts'
import { isWaitPrompt } from '../../shared/waits.ts'
import { startDraftOf } from '../../shared/startDraft.ts'
import type { AgentStartRequest, AgentStartResponse, StartDraftActionRequest, StartDraftActionResponse } from '../../shared/types.ts'
import { MAX_REPLY_BYTES } from '../appContext.ts'
import type { AppContext } from '../appContext.ts'
import { splitArgs } from './runner.ts'
import type { StartDraftStore } from './startDrafts.ts'

export function createStartRoutes(ctx: AppContext & { startDrafts: StartDraftStore; worktreeAddable: boolean }) {
  const { store, run, agents, settingsStore, startDrafts, worktreeAddable, agentRefusal, agentFrom, readJson, json, error, isCrossOrigin } = ctx

  /**
   * `POST /api/agent/start`（`sai_start`）。**置けるのは、SAI が起こしていま回しているターンの自分のセッションだけ**（`agentFrom()`）。
   * 受けるのは worktree の名前・エージェント・最初の指示だけで、置き場は押したときに**このセッションの行の cwd のリポジトリ**から組む
   * （パス・リポジトリ・ブランチ・base は受けない）。そのため、ほかのリポジトリ（送れる相手の組 `mayCross()` の外も中も）には作れない。
   * 許可を聞かないモードのセッションからは置かせない（#892。`/mcp` が素通しのセッションに送らないのと同じ線）
   */
  const agentStart = async (req: IncomingMessage, res: ServerResponse) => {
    const refusal = agentRefusal(req)
    if (refusal) return error(res, 403, refusal)
    let body: unknown
    try {
      body = await readJson(req, MAX_REPLY_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const b = (body ?? {}) as Partial<AgentStartRequest>
    const found = await agentFrom(b.from)
    if (typeof found === 'string') return error(res, 409, found)
    const { session } = found
    if (agents.isStopped(session.id)) return error(res, 409, '人がこのセッションからの送信を止めているので、案も置けません')
    // 人が見ていない間に SAI が起こしたターン（待ちで起きた・別のセッションのメッセージで回っている）からは置かせない（`sai_send` / `sai_wait_for` と同じ線）
    const turnText = splitHandedReplies(run.snapshot()[session.id]?.text ?? '').text
    if (isWaitPrompt(turnText)) return error(res, 409, '待ちで起きたターンからは、新しいセッションの案を置けません（結果を報告して終えてください）')
    // 回数の上限は見ない（案は送信ではない）。見るのはメッセージで回っているターンか（連鎖は 1 段まで）だけ
    const chained = agents.refusal(session.id, found.turn, Number.POSITIVE_INFINITY)
    if (chained) return error(res, 409, `${chained}（新しいセッションの案も置けません）`)
    // 素通しで回っているターンからは置かせない。見るのは 3 つ: いまのメタ（既定が素通しなら、メタに何も無いセッションも素通しで回る。#582。
    // 既定が付くのは Claude だけ）・**いま回っているターンを起こしたときのモード**（起こしたあとでメタを戻しても、そのターンは素通しのまま）・
    // 運用者が `SAI_CLAUDE_ARGS` で渡しているモード（ループの断り `loopRefusal()` と同じ）
    const mode = replyModeOf(session.meta?.permission_mode, session.agent === 'claude' ? (await settingsStore.get()).reply_mode : '')
    const launched = run.snapshot()[session.id]?.permission_mode ?? ''
    const skips = modeSkipsRules(mode) ? mode : modeSkipsRules(launched) ? launched : skipModeInArgs(splitArgs(process.env.SAI_CLAUDE_ARGS))
    if (skips) return error(res, 403, `許可を聞かないモード（${modeName(skips)}）のセッションからは、新しいセッションの案を置けません`)
    if (!session.cwd) return error(res, 409, 'このセッションの作業ディレクトリが分からないので、worktree の置き場を決められません')
    if (!worktreeAddable) return error(res, 409, 'この SAI には worktree を作る口がありません（画面の「新しい worktree を作る」も出ません）')
    const made = startDraftOf(b)
    if ('error' in made) return error(res, 400, made.error)
    const draft = await startDrafts.put(session.id, made.draft)
    // 本文は残さない（長さだけ）
    await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${session.id} 新しいセッションの案を置いた（worktree ${draft.name}・${draft.agent}・${draft.text.length} 字）\n`).catch(() => {})
    const payload: AgentStartResponse = { placed: true, draft }
    return json(res, payload, 201)
  }

  /** `POST /api/sessions/<id>/start-draft`。人が案を片付ける（始めた・捨てた）。`at` が置いてあるものと同じときだけ */
  const startDraftAction = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_REPLY_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const { at } = (body ?? {}) as Partial<StartDraftActionRequest>
    if (typeof at !== 'number' || !Number.isFinite(at)) return error(res, 400, 'at が要ります')
    const taken = await startDrafts.take(id, at)
    if (taken) await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} 新しいセッションの案（worktree ${taken.name}）を片付けた\n`).catch(() => {})
    const payload: StartDraftActionResponse = { id, taken: Boolean(taken) }
    return json(res, payload)
  }

  return { agentStart, startDraftAction }
}
