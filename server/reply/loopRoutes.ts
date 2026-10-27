// ループ（#634）の区分。`createApp()`（app.ts）から外に出したもの（#807）。決まりごと（検査・周の文・周の終わりの状態）は
// `shared/loops.ts`、置き場は `server/reply/loops.ts`。ここは口の処理と時計の 1 回ぶん。
//
// `createLoopRoutes(ctx)` は関数を作って返すだけで、時計は立てない（立てるのは `createApp()` が今までの位置で呼ぶ `syncLoopTimer()`）
import { appendFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { usageRefusal } from '../../shared/agentMessages.ts'
import { clampInterval, loopAfterRound, loopFromRequest, loopHalt, loopLive, LOOP_NOTE_MAX, loopPrompt } from '../../shared/loops.ts'
import type { LoopState } from '../../shared/loops.ts'
import { modeName, modeSkipsRules, skipModeInArgs } from '../../shared/permissions.ts'
import { replyBlockedReason, replyFailureText } from '../../shared/reply.ts'
import type { LoopNextRequest, LoopNextResponse, LoopResponse, ReplyError, SessionSummary } from '../../shared/types.ts'
import { MAX_REPLY_BYTES, QUEUE_DAYS } from '../appContext.ts'
import type { AppContext } from '../appContext.ts'
import { selfHost } from '../host.ts'
import { splitArgs } from './runner.ts'

/** 人がループを組む・片付ける（`/loop`）と、止める・再開・いま起こす（#634）。長い方から突き合わせる */
export const LOOP_SUFFIXES = ['/loop/stop', '/loop/resume', '/loop/wake', '/loop'] as const

export function createLoopRoutes(ctx: AppContext) {
  const { store, loops, run, launching, typed, queue, codexApp, opencodeApp, metaStore, usageStore, loopNow, loopTickMs } = ctx
  const { launch, sessionsWithMeta, failedReply, replyMode, terminalOf, agentRefusal, agentFrom, json, error, readJson, isCrossOrigin, selfUrl } = ctx

  const loopLog = (id: string, message: string) => appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} ループ: ${message}\n`).catch(() => {})
  /** 失敗で一時停止したあと「再開」を押したときの、その失敗（`Replying.since`）。同じ失敗でもう一度止めない */
  const loopResumedFailure = new Map<string, string>()

  /** 回っているループを一時停止する（人が送った・人がターンを止めた）。回っていなければ何もしない */
  const pauseLoop = async (id: string, reason: string): Promise<void> => {
    const l = loops.get(id)
    if (l?.status !== 'running') return
    loops.set(id, loopHalt(l, 'paused', `${reason}。続けるなら「再開」`))
    await loopLog(id, `一時停止（${reason}）`)
  }

  /**
   * そのセッションにループを組めない・周を起こせない理由。無ければ空。組むときと、周を起こす直前の両方で見る
   * （組んだあとに端末で開いた・許可モードを素通しにした、も止める）。
   *
   * - **Claude だけ**: エージェントが「次」を言う口（`sai_loop_next`）は SAI が `claude -p` に渡す MCP にしか無い
   * - **端末で開いているセッションには組まない**: 打ち込む経路には MCP が無く、端末の `/loop` と二重に回るのを見分けられない
   * - **ルールに関係なく通るモード（`bypassPermissions` / `auto`。#691）には組まない**: 人が見ていない間に、何も聞かれずに回り続ける。
   *   運用者が `SAI_CLAUDE_ARGS` で渡しているときも同じ（`skipModeInArgs()`。1 語の形も見る）。判定は `modeSkipsRules()` の 1 つ
   *   **待ち（`kind: 'wait'`）はここを見ない**: 回り続けるループと違い、1 つの待ちで起こすのは 1 回で、次も預けられない
   */
  const loopRefusal = async (session: SessionSummary, kind: 'loop' | 'wait' = 'loop'): Promise<string> => {
    // 待ち（#732）も同じ線を引く（人が見ていない間に SAI が起こすターン）。**許可を聞かないモードだけは待ちでは断らない**
    const cannot = kind === 'loop' ? 'ループを組めません' : '待ちを預かれません'
    if (session.archived) return `アーカイブ済みのセッションには${cannot}`
    const blocked = replyBlockedReason(session, selfHost())
    if (blocked) return blocked
    if (session.agent !== 'claude') return kind === 'loop' ? 'ループを組めるのは、いまは Claude のセッションだけです' : '待ちを預かれるのは、いまは Claude のセッションだけです'
    const extra = splitArgs(process.env.SAI_CLAUDE_ARGS)
    if (process.env.SAI_APPROVE === '0' || extra.includes('--permission-prompt-tool')) return kind === 'loop' ? 'SAI の MCP を渡していない（SAI_APPROVE=0 など）ので、エージェントが次を言う口がありません' : 'SAI の MCP を渡していない（SAI_APPROVE=0 など）ので、待ちを預かれません'
    // 待ちは 1 つで 1 回しか起こさず、起きたターンから先へ送る・次を預けることもできないので、ここは見ない
    if (kind === 'loop') {
      const mode = await replyMode(await metaStore.get(session.id))
      const skips = modeSkipsRules(mode) ? mode : skipModeInArgs(extra)
      if (skips) return `許可を聞かないモード（${modeName(skips)}）のセッションには${cannot}`
    }
    if (await terminalOf(session)) return kind === 'loop' ? '端末で開いているセッションにはループを組めません（端末の /loop と二重に回るのを避けるため）' : '端末で開いているセッションには待ちを預かれません（起こすときに端末へ打ち込むことになるため）'
    return ''
  }

  /**
   * ループを 1 つ進める。周のターンが終わっていれば次の時刻を決め（`loopAfterRound()`）、時刻が来ていれば次の周を起こす。
   *
   * - 起こす経路は返信と同じ `launch()`（`replyBlockedReason()`・モデル・許可モードはそのまま。**SAI は権限のフラグを足さず、
   *   許可も自動で返さない**）。許可・質問で止まっている間はターンが回っているので、次の周は起こさない
   * - **周を送る前に「送った」を書く**（`turn: 'pending'`）。そのまま落ちても、立て直したあとは「その周は終わった」として
   *   次の時刻を待つので、同じ周を 2 回は送らない
   * - 前のターンが回っている・預かりが残っている間は待つ。周のターンが失敗したら止める
   * - 止める歯止め: 終わりの時刻・周の上限・使用量の枠（`usageRefusal()`）・申し送りが変わらない（`loopAfterRound()`）
   */
  const tickLoop = async (id: string): Promise<void> => {
    const l = loops.get(id)
    if (!l) return
    const now = loopNow()
    // **読んだあとに await を挟んだら、書く前にもう一度見る**（#640 のレビュー）: その間に人が止めた・片付けた・一時停止したなら、
    // 古い状態で上書きしない（止めたループを `running` に戻して次の周を起こさない）。置き場は書くたびに新しい値を入れるので、同じ値かで分かる
    const moved = () => loops.get(id) !== l
    const halt = async (state: LoopState, status: Exclude<LoopState['status'], 'running'>, reason: string) => {
      if (moved()) return
      loops.set(id, loopHalt(state, status, reason))
      await loopLog(id, `${status}（${reason}）`)
    }
    if (l.turn) {
      if (run.running(id) || launching.has(id)) return
      const r = run.snapshot()[id]
      if (r?.failed && (l.turn === 'pending' || r.since === l.turn)) return halt(l, 'stopped', `${l.round} 周目のターンが失敗しました（${replyFailureText(r.failed)}）`)
      const next = loopAfterRound(l, now)
      loops.set(id, next)
      await loopLog(id, `${l.round} 周目が終わった（${next.status}${next.next_at ? `。次は ${next.next_at}` : ''}${next.reason ? `。${next.reason}` : ''}）`)
      return
    }
    if (l.status !== 'running' || !l.next_at || Date.parse(l.next_at) > now) return
    if (now >= Date.parse(l.deadline)) return halt(l, 'stopped', '終わりの時刻になりました')
    if (l.round >= l.max_rounds) return halt(l, 'stopped', `上限の ${l.max_rounds} 周を回りました`)
    if (run.running(id) || codexApp.running(id) || opencodeApp.running(id) || typed.running(id) || launching.has(id) || queue.size(id) > 0) return
    const failed = failedReply(id)
    if (failed && loopResumedFailure.get(id) !== failed.since) return halt(l, 'paused', '前の返信が失敗しています。確かめてから「再開」してください')
    const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
    const session = sessions.find((s) => s.id === id)
    if (!session) return halt(l, 'paused', 'セッションが記録の窓に見つかりません')
    const refusal = await loopRefusal(session)
    if (refusal) return halt(l, 'paused', refusal)
    const over = usageRefusal(await usageStore.get(), session.agent)
    if (over) return halt(l, 'stopped', over)
    if (moved()) return
    const { next_at: _next, said: _said, ...rest } = l
    const sending: LoopState = { ...rest, round: l.round + 1, turn: 'pending' }
    loops.set(id, sending)
    const out = await launch(id, loopPrompt(sending, now), [], { days: QUEUE_DAYS, replaceTyped: false, forceProcess: true, url: l.url ?? '', queue: false, loop: true })
    // その間に人が止めた・片付けたなら、そちらを残す
    const cur = loops.get(id)
    if (!cur || cur.turn !== 'pending') return
    if (out.status === 202) {
      loops.set(id, { ...cur, turn: run.snapshot()[id]?.since ?? 'pending' })
      await loopLog(id, `${sending.round} 周目を起こした`)
      return
    }
    // `claude --bg` のターンを待っている（#462）。止めずに、次に見に来たときにもう一度
    if (out.retry) {
      // ここまで来たのは、置き場がまだ自分の書いた `sending` のとき（上で見ている）
      loops.set(id, l)
      return
    }
    loops.set(id, loopHalt(l, 'paused', `${sending.round} 周目を起こせませんでした: ${(out.body as ReplyError).error}`))
    await loopLog(id, `paused（${sending.round} 周目を起こせなかった）`)
  }

  let loopTicking = false
  let loopTimer: ReturnType<typeof setInterval> | undefined
  /** 見に行く相手がいる間だけタイマーを立てる（画面を開いていなくても回るように。プロセスは引き留めない） */
  const syncLoopTimer = (): void => {
    const want = loopTickMs > 0 && loops.active().length > 0
    if (want && !loopTimer) {
      loopTimer = setInterval(() => void tickLoops().catch(() => {}), loopTickMs)
      loopTimer.unref()
    } else if (!want && loopTimer) {
      clearInterval(loopTimer)
      loopTimer = undefined
    }
  }
  /** 組んであるループを全部見る。タイマーと、画面のポーリングのついでに呼ぶ（重なっても 1 本だけ） */
  const tickLoops = async (): Promise<void> => {
    if (loopTicking) return
    loopTicking = true
    try {
      for (const [id] of loops.active()) await tickLoop(id)
    } finally {
      loopTicking = false
      syncLoopTimer()
    }
  }

  /**
   * 人がループを組む・止める・再開する・いま起こす・片付ける（#634）。**同一オリジンのみ**（返信と同じ理由。組むと CLI を起こす）。
   * `cwd` もパスも受けない（周は返信と同じ経路で、セッションの行から起こす）
   */
  const loopAction = async (req: IncomingMessage, res: ServerResponse, id: string, suffix: (typeof LOOP_SUFFIXES)[number]) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    const method = req.method ?? 'GET'
    const cur = loops.get(id)
    const at = new Date(loopNow()).toISOString()
    if (suffix === '/loop') {
      if (method === 'DELETE') {
        if (!loops.delete(id)) return error(res, 404, 'このセッションにループは組まれていません')
        await loopLog(id, '人が片付けた')
      } else {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        if (cur && loopLive(cur.status)) return error(res, 409, 'もうループが組まれています。止めてから組み直してください')
        let body: unknown
        try {
          body = await readJson(req, MAX_REPLY_BYTES)
        } catch (err) {
          return error(res, 400, err instanceof Error ? err.message : 'bad body')
        }
        const made = loopFromRequest(body, loopNow())
        if ('error' in made) return error(res, 400, made.error)
        const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
        const session = sessions.find((s) => s.id === id)
        if (!session) return error(res, 404, 'session not found in window')
        const refusal = await loopRefusal(session)
        if (refusal) return error(res, 400, refusal)
        loops.set(id, { ...made.loop, url: selfUrl(req) })
        await loopLog(id, `人が組んだ（上限 ${made.loop.max_rounds} 周・${made.loop.deadline} まで・既定の間隔 ${made.loop.interval_s} 秒）`)
        await tickLoops()
      }
    } else {
      if (method !== 'POST') return error(res, 405, 'method not allowed')
      if (!cur) return error(res, 404, 'このセッションにループは組まれていません')
      if (suffix === '/loop/stop') {
        if (!loopLive(cur.status)) return error(res, 409, 'このループはもう終わっています')
        // 回っている周のターンは止めない（止めるのは見出しの「止める」）。次の周を起こさないだけ
        loops.set(id, loopHalt(cur, 'stopped', '人が止めました'))
        await loopLog(id, '人が止めた')
      } else if (suffix === '/loop/resume') {
        if (cur.status !== 'paused') return error(res, 409, '一時停止しているループだけ再開できます')
        const failed = failedReply(id)
        if (failed) loopResumedFailure.set(id, failed.since)
        const { reason: _reason, ...rest } = cur
        loops.set(id, { ...rest, status: 'running', stalled: 0, url: selfUrl(req), ...(cur.turn ? {} : { next_at: at }) })
        await loopLog(id, '人が再開した')
        await tickLoops()
      } else {
        if (cur.status !== 'running' || cur.turn) return error(res, 409, 'いま起こせるのは、次の周を待っているループだけです')
        loops.set(id, { ...cur, next_at: at })
        await loopLog(id, '人がいま起こした')
        await tickLoops()
      }
    }
    syncLoopTimer()
    const payload: LoopResponse = { id, loop: loops.snapshot()[id] ?? null }
    return json(res, payload)
  }

  /**
   * `POST /api/agent/loop`（`sai_loop_next`。#634）。エージェントが周の終わりに「続ける（何秒後・申し送り）／終わり／諦める」を言う。
   * **動かせるのは、自分に組まれたループの、いま回っている周だけ**（送り元は `agentFrom()`＝SAI が起こしていま回しているターン。
   * 別のセッションのループ・周でないターン・上限・目的は動かせない）。間隔は SAI が丸める
   */
  const agentLoopNext = async (req: IncomingMessage, res: ServerResponse) => {
    const refusal = agentRefusal(req)
    if (refusal) return error(res, 403, refusal)
    let body: unknown
    try {
      body = await readJson(req, MAX_REPLY_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const b = (body ?? {}) as Partial<LoopNextRequest>
    const found = await agentFrom(b.from)
    if (typeof found === 'string') return error(res, 409, found)
    const id = found.session.id
    const l = loops.get(id)
    if (!l || !l.turn || (l.turn !== 'pending' && l.turn !== found.turn)) return error(res, 409, 'このターンはループの周ではありません（動かせるのは、自分に組まれたループの、いま回っている周だけです）')
    const note = typeof b.note === 'string' ? b.note.trim() : ''
    if (note.length > LOOP_NOTE_MAX) return error(res, 400, `note は ${LOOP_NOTE_MAX} 字までです。短くまとめてください`)
    if (b.action === 'continue') {
      const seconds = clampInterval(b.seconds, l.interval_s)
      loops.set(id, { ...l, said: { seconds, note } })
      await loopLog(id, `${l.round} 周目: 続ける（${seconds} 秒後）`)
      const payload: LoopNextResponse = { status: l.status, round: l.round, max_rounds: l.max_rounds, ...(l.round < l.max_rounds ? { next_in_s: seconds } : {}) }
      return json(res, payload)
    }
    if (b.action !== 'done' && b.action !== 'give_up') return error(res, 400, 'action は continue / done / give_up のどれかです')
    if (!note) return error(res, 400, b.action === 'done' ? 'note に、終わりの条件を満たした根拠を書いてください' : 'note に、進められない理由を書いてください')
    const status = b.action === 'done' ? 'done' : 'gave_up'
    loops.set(id, loopHalt(l, status, note))
    await loopLog(id, `${l.round} 周目: ${status}`)
    const payload: LoopNextResponse = { status, round: l.round, max_rounds: l.max_rounds }
    return json(res, payload)
  }

  /** タイマーを消す（`dispose()` から） */
  const stopLoopTimer = (): void => {
    if (loopTimer) clearInterval(loopTimer)
  }

  return { pauseLoop, loopRefusal, tickLoops, syncLoopTimer, stopLoopTimer, loopAction, agentLoopNext }
}
