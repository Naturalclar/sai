// 待ち（#732）の区分。`createApp()`（app.ts）から外に出したもの（#808）。決まりごと（受ける形・結果の読み方・上限）は
// `shared/waits.ts`、置き場は `server/reply/waits.ts`。ここは「PR の CI が終わったら、そのセッションを 1 回起こす」口の処理と時計の 1 回ぶん。
//
// `createWaitRoutes(ctx)` は関数を作って返すだけで、時計は立てない（立てるのは `createApp()` が今までの位置で呼ぶ `syncWaitTimer()`）
import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { splitHandedReplies, usageRefusal } from '../../shared/agentMessages.ts'
import { loopLive } from '../../shared/loops.ts'
import { githubRepoOf } from '../../shared/prs.ts'
import type { ReplyError, SessionSummary, WaitActionRequest, WaitActionResponse, WaitForRequest, WaitForResponse } from '../../shared/types.ts'
import { WAIT_HUMAN_THEN } from '../../shared/waitingSaid.ts'
import { isWaitPrompt, WAIT_FAILING_MAX, WAIT_MAX_MS, WAIT_MAX_PER_SESSION, WAIT_POLL_MS, WAIT_READY_MAX_MS, WAIT_WAKES_PER_DAY, waitConfirmed, waitFinishedLate, waitFromRequest, waitLateReason, waitLimitRefusal, waitLive, waitOutcome, waitPrompt, waitReplaceable, waitResultText, waitWakeable, wakesExhausted } from '../../shared/waits.ts'
import type { WaitState } from '../../shared/waits.ts'
import { HOLDING_PR_STALE_MS, MAX_REPLY_BYTES, QUEUE_DAYS } from '../appContext.ts'
import type { AppContext, Launched, LoopRefusal } from '../appContext.ts'

/** 人が待ちを止める・いま起こす（#732）。どの待ちかは body の `wait` */
export const WAIT_SUFFIXES = ['/wait/stop', '/wait/wake', '/wait/add'] as const

/** 待ちの断る線はループと同じ `loopRefusal()` なので、ループの区分が返したものを足して渡す */
export function createWaitRoutes(ctx: AppContext & { loopRefusal: LoopRefusal }) {
  const { store, run, launching, typed, queue, waits, loops, agents, prs, progress, codexApp, opencodeApp, usageStore, loopNow, waitTickMs } = ctx
  const { launch, sessionsWithMeta, failedReply, loopRefusal, messageCompactOf, agentRefusal, agentFrom, json, error, readJson, isCrossOrigin, selfUrl } = ctx

  const waitLog = (id: string, message: string) => appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} 待ち: ${message}\n`).catch(() => {})
  const waitIso = (ms: number) => new Date(ms).toISOString()
  /** 終わったのに起こせなかった待ちを、次に見に行く時刻（待ちの id → ms） */
  const waitRetryAt = new Map<string, number>()
  const WAIT_RETRY_MS = 10_000
  const WAIT_BG_RETRY_MS = 30_000
  const WAIT_SLOW_RETRY_MS = 60_000
  /** 起こせなかった理由の種類（待ちの id → 種類）。同じ種類のあいだは置き場を書き直さない */
  const waitHeldFor = new Map<string, string>()
  /** いま回しているターンの本文（SAI が頭に足した返答の塊は外す）。待ちで起きたターン・ループの周かを見る */
  const turnTextOf = (id: string): string => splitHandedReplies(run.snapshot()[id]?.text ?? '').text

  /**
   * 終わった待ちでセッションを起こす。起こせたら空、起こさなかったら理由（待ちに `reason` として残る）。
   *
   * - 起こす経路は返信・ループと同じ `launch()`（**SAI は権限のフラグを足さず、許可も自動で返さない**）。断る線は `loopRefusal(session, 'wait')`（許可を聞かないモードは断らない）
   * - 処理中・預かりが残っている・前の返信が失敗しているセッションは追い越さない（終わる・片付くまで `ready` のまま待つ）
   * - 使用量の枠が残り少ない・1 日の回数を超えたときは起こさない。**人の「いま起こす」（`forced`）だけがこの 2 つを越える**
   * - 要約は挟まない: 判定は画面からの送信・`sai_send` と同じ `messageCompacts()` で、待ちの結果は着手の形にならないので、間があいて読み直す量が大きくてもそのまま起こす（短い依頼。#761、2026-10-15）
   * - **起こす前に `waking` を書く**。その途中で立て直されたら、届いたか分からないので送り直さない（`WaitStore` が `halted` にする）。
   *   起こせた待ちは消す（1 つの待ちで起こすのは 1 回）
   */
  const wakeWait = async (id: string, waitId: string, forced: boolean): Promise<string> => {
    const w = waits.get(id, waitId)
    if (!w) return 'その待ちはもうありません'
    const now = loopNow()
    // 読んだあとに await を挟んだら、書く前にもう一度見る（その間に人が止めたものを戻さない）
    const moved = () => waits.get(id, waitId) !== w
    const hold = (reason: string, kind: string, slow = false): string => {
      // 人の「いま起こす」で起こせなかったときは、待ちには書かない（押した人に理由を返すだけ。「終わったら起こします」は
      // 自動で見に行く待ちにしか当てはまらない）
      if (forced) return reason
      // 起こせない間は、見に行くたびに記録や使用量を読み直さない。枠・回数のように長く続く理由は間を空ける
      waitRetryAt.set(waitId, now + (slow ? WAIT_SLOW_RETRY_MS : WAIT_RETRY_MS))
      // 同じ種類の理由なら書き直さない（使用量の文は割合が入るので、動くたびに書くと rev が進んで画面が描き直す）
      if (!moved() && waitHeldFor.get(waitId) !== kind) {
        waitHeldFor.set(waitId, kind)
        waits.set(id, { ...w, reason })
      }
      return reason
    }
    if (run.running(id) || codexApp.running(id) || opencodeApp.running(id) || typed.running(id) || launching.has(id) || queue.size(id) > 0) return hold('セッションが処理中です（終わったら起こします）', 'busy')
    if (failedReply(id)) return hold('前の返信が失敗しています（確かめて片付けたら起こします）', 'failed')
    // ここから先の読み取り（記録・端末の走査・使用量・transcript）が失敗しても、理由を残して間を空ける（黙って 5 秒ごとに繰り返さない）
    let session: SessionSummary | undefined
    let context = 0
    try {
      session = (await sessionsWithMeta(QUEUE_DAYS)).sessions.find((s) => s.id === id)
      if (!session) return hold('セッションが記録の窓に見つかりません', 'gone', true)
      const refusal = await loopRefusal(session, 'wait')
      if (refusal) return hold(refusal, 'refused', true)
      if (!forced) {
        const over = usageRefusal(await usageStore.get(), session.agent)
        if (over) return hold(`${over}（枠が戻ったら起こします。「いま起こす」でも起こせます）`, 'usage', true)
        if (wakesExhausted(waits.wakesOf(id, now), now)) return hold(`待ちで自動で起こすのは 24 時間に ${WAIT_WAKES_PER_DAY} 回までです（「いま起こす」で起こせます）`, 'daily', true)
      }
      context = (await progress.read(session)).context_tokens
    } catch (err) {
      return hold(`起こす前の確認で失敗しました（もう一度見に行きます）: ${err instanceof Error ? err.message : String(err)}`, 'error', true)
    }
    if (moved()) return 'その待ちは変わりました'
    const { reason: _reason, next_check_at: _next, ...rest } = w
    const sending: WaitState = { ...rest, status: 'waking' }
    waits.set(id, sending)
    const text = waitPrompt(sending)
    const compact = Boolean(messageCompactOf(session, text, context, undefined).compact)
    let out: Launched
    try {
      out = await launch(id, text, [], { days: QUEUE_DAYS, replaceTyped: false, forceProcess: true, url: w.url ?? '', queue: false, ...(compact ? { compact: true, compactFrom: text } : {}) })
    } catch (err) {
      // 起こす途中で例外になっても `waking` のまま残さない（残すと、誰も見に行かず枠も使い続ける）
      out = { status: 500, body: { error: err instanceof Error ? err.message : String(err) } }
    }
    // その間に人が止めた（消した）なら、そちらを残す
    if (waits.get(id, waitId) !== sending) return ''
    if (out.status === 202) {
      waits.remove(id, waitId)
      waitRetryAt.delete(waitId)
      waitHeldFor.delete(waitId)
      if (!forced) waits.woke(id, now)
      await waitLog(id, `PR #${w.pr} で起こした（${waitResultText(w.result) || '人がいま起こした'}${compact ? '。要約してから' : ''}${forced ? '。人の「いま起こす」' : ''}）`)
      return ''
    }
    // `claude --bg` のターンを待っている（#462）。止めずに、少し置いてからもう一度（毎回見に行くと置き場を書き続ける）
    if (out.retry) {
      waits.set(id, w)
      waitRetryAt.set(waitId, now + WAIT_BG_RETRY_MS)
      return 'retry'
    }
    // 上で見たあとに人が返信した（409）。処理中と同じ扱いで、終わったらもう一度（止めっぱなしにしない）
    if (out.status === 409 && !forced && w.status === 'ready') {
      waits.set(id, { ...w, reason: 'セッションが処理中です（終わったら起こします）' })
      waitHeldFor.set(waitId, 'busy')
      waitRetryAt.set(waitId, now + WAIT_RETRY_MS)
      return (out.body as ReplyError).error
    }
    const why = `起こせませんでした: ${(out.body as ReplyError).error}`
    // 人の「いま起こす」で起こせなかったときは、待ちを元に戻す（確かめている途中の待ちを止めっぱなしにしない。理由は押した人に返す）
    if (forced) {
      waits.set(id, w)
      return why
    }
    waits.set(id, { ...rest, status: 'halted', reason: why })
    await waitLog(id, `PR #${w.pr}: ${why}`)
    return why
  }

  /**
   * 待ちを 1 つ進める。確かめる時刻が来ていれば `gh` で読み（**決まった形の 1 本だけ**。エージェントのターンは回さない）、
   * 終わっていれば（緑でも赤でも）起こしに行く。待てる時間を過ぎたら起こさずに `expired` にして画面に残す。
   * 待ち始めてから `WAIT_AUTO_WAKE_MS` を過ぎて終わったときは、結果を出すだけで起こさない（`late`。人の「いま起こす」を待つ）
   */
  const tickWait = async (id: string, waitId: string): Promise<void> => {
    const w = waits.get(id, waitId)
    if (!w || w.status === 'waking' || !waitLive(w.status)) return
    const now = loopNow()
    if (w.status === 'waiting') {
      const pastDeadline = now >= Date.parse(w.deadline)
      if (!pastDeadline && w.next_check_at && Date.parse(w.next_check_at) > now) return
      // 待てる時間を過ぎていても、最後に 1 回は読む（サーバが止まっていた・Mac が眠っていた間に終わっていることがある）
      const ci = prs.ci ? await prs.ci(w.repo, w.pr) : null
      if (waits.get(id, waitId) !== w) return
      const seen = ci ? waitOutcome(ci, Date.parse(w.since), now) : null
      // 「通った」「落ちた」は 1 回見ただけでは信じない（push・回し直しの直後は、前の結果や速いチェックだけが載っていることがある）。
      // 次に確かめたときも同じなら終わり。最後の 1 回（時間切れ）のときはそのまま信じる
      const outcome = waitConfirmed(seen, w.seen_once, pastDeadline)
      const { reason: _reason, seen_once: _seen, next_check_at: _next, ...rest } = w
      if (!outcome) {
        if (pastDeadline) {
          waits.set(id, { ...rest, status: 'expired', reason: `${Math.round(WAIT_MAX_MS / 60_000)} 分待ちましたが、CI が終わりませんでした` })
          await waitLog(id, `PR #${w.pr}: 待てる時間を過ぎた（起こしていない）`)
          return
        }
        waits.set(id, {
          ...rest,
          next_check_at: waitIso(now + WAIT_POLL_MS),
          ...(seen === 'success' || seen === 'failure' ? { seen_once: seen } : {}),
          ...(ci ? { checked_at: waitIso(now) } : { reason: 'gh で読めませんでした（次にもう一度確かめます）', ...(w.seen_once ? { seen_once: w.seen_once } : {}) }),
        })
        return
      }
      // 待ち始めてから長く経って終わった: キャッシュが切れていて、起こすと文脈を読み直す。結果だけ出して、人の「いま起こす」に任せる
      const manual = waitFinishedLate(w.since, now)
      waits.set(id, { ...rest, status: 'ready', result: outcome, failing: ci!.failing.slice(0, WAIT_FAILING_MAX), checked_at: waitIso(now), ...(manual ? { late: true as const, reason: waitLateReason() } : {}) })
      await waitLog(id, `PR #${w.pr}: ${waitResultText(outcome)}${manual ? '（待ち始めてから長いので、自動では起こさない）' : ''}`)
      if (manual) return
    } else {
      // 終わったのに起こせないまま長く経ったら、見に行くのをやめる（起こせない待ちが同時の数の枠を使い続けない）
      if (now - Date.parse(w.checked_at ?? w.since) >= WAIT_READY_MAX_MS) {
        const hours = Math.round(WAIT_READY_MAX_MS / 3_600_000)
        waits.set(id, { ...w, status: 'halted', reason: w.late ? `終わってから ${hours} 時間、起こされませんでした（自動では起こさない待ちでした）` : `終わってから ${hours} 時間、起こせませんでした（${w.reason ?? '理由は分かりません'}）` })
        await waitLog(id, `PR #${w.pr}: 終わってから起こせないまま時間切れ`)
        return
      }
      // 自動では起こさないと決めた待ちは、人の「いま起こす」だけが起こす（立て直したあとも同じ）
      if (w.late) return
      if ((waitRetryAt.get(waitId) ?? 0) > now) return
    }
    await wakeWait(id, waitId, false)
  }

  let waitTicking = false
  let waitTimer: ReturnType<typeof setInterval> | undefined
  /** 見に行く相手がいる間だけタイマーを立てる（画面を開いていなくても確かめる。ループと同じ形） */
  const syncWaitTimer = (): void => {
    const want = waitTickMs > 0 && waits.live().length > 0
    if (want && !waitTimer) {
      waitTimer = setInterval(() => void tickWaits().catch(() => {}), waitTickMs)
      waitTimer.unref()
    } else if (!want && waitTimer) {
      clearInterval(waitTimer)
      waitTimer = undefined
    }
  }
  const tickWaits = async (): Promise<void> => {
    if (waitTicking) return
    waitTicking = true
    try {
      for (const [id, w] of waits.live()) await tickWait(id, w.id).catch(() => {})
    } finally {
      waitTicking = false
      syncWaitTimer()
    }
  }
  /**
   * `POST /api/agent/wait-for`（`sai_wait_for`。#732）。エージェントが「PR の CI が終わったら起こして」を預ける。
   * **預けられるのは、SAI が起こしていま回しているターンの自分のセッションだけ**（`agentFrom()`）。受けるのは PR の番号と
   * 起きたときにやることの 1 文で、リポジトリはセッションの行の remote から決める（**記録で知っているものだけ**。名前は受けない）。
   * 長さ・間隔・回数を動かす引数は無い。もう終わっていれば預からずに結果を返す（起こす 1 回を使わない）
   */
  const agentWaitFor = async (req: IncomingMessage, res: ServerResponse) => {
    const refusal = agentRefusal(req)
    if (refusal) return error(res, 403, refusal)
    let body: unknown
    try {
      body = await readJson(req, MAX_REPLY_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const b = (body ?? {}) as Partial<WaitForRequest>
    const found = await agentFrom(b.from)
    if (typeof found === 'string') return error(res, 409, found)
    const id = found.session.id
    // 待ちで起きたターンから次の待ちを預けさせない（起きたときにやってよいのは報告まで。待ち → 起きる → 待ち、を自動で回さない）
    const turnText = turnTextOf(id)
    if (isWaitPrompt(turnText)) return error(res, 409, '待ちで起きたターンからは、次の待ちを預けられません（結果を報告して終えてください）')
    if (loops.get(id)?.turn) return error(res, 409, 'ループの周からは待ちを預けられません（次に起きる時刻は sai_loop_next で言ってください）')
    if (agents.isStopped(id)) return error(res, 409, '人がこのセッションからの送信を止めているので、待ちも預かれません')
    const made = waitFromRequest(b)
    if ('error' in made) return error(res, 400, made.error)
    const blocked = await loopRefusal(found.session, 'wait')
    if (blocked) return error(res, 400, blocked)
    const placed = await depositWait(id, found.session, made, selfUrl(req))
    if ('error' in placed) return error(res, placed.status, placed.error)
    return json(res, placed)
  }

  /**
   * 待ちを 1 件預かる（#732）。エージェントの口（`sai_wait_for`）と、人が画面から置く口（`/wait/add`）が同じ道を通る
   * （同じ置き場・同じ上限）。**断る線（`loopRefusal()`）と送信の停止は呼ぶ側が先に見る**。
   * リポジトリはセッションの行の remote から決める。預かる前に 1 回読み、もう終わっていれば預からずに結果を返す
   */
  const depositWait = async (id: string, session: SessionSummary, made: { pr: number; then: string }, url: string): Promise<WaitForResponse | { status: number; error: string }> => {
    const repo = githubRepoOf(session.remote)
    if (!repo) return { status: 400, error: 'このセッションのリポジトリ（origin）が GitHub のものと分からないので、PR を確かめられません' }
    if (!prs.available || !prs.ci) return { status: 400, error: 'gh を使わない設定（SAI_GH=0）なので、CI を確かめられません' }
    const limit = waitLimitRefusal(waits.of(id), repo, made.pr)
    if (limit) return { status: 429, error: limit }
    // 預かる前に 1 回読む: 番号違い・gh が使えない、を黙って待たない。もう終わっていれば預からない
    const ci = await prs.ci(repo, made.pr)
    if (!ci) return { status: 400, error: `PR #${made.pr}（${repo}）を gh で読めませんでした（番号と gh のログインを確かめてください）` }
    const now = loopNow()
    const left = () => Math.max(0, WAIT_MAX_PER_SESSION - waits.of(id).filter((w) => waitLive(w.status)).length)
    // 預かった時刻を now にすると「チェックがまだ載っていない」の猶予が効くので、ここでは猶予を見ない（載っていなければ待つ）
    // **「通った」「落ちた」はここでは信じない**（push・回し直しの直後は、前の結果や速いチェックだけが載っていることがある）。
    // 預かって、次に確かめたときも同じなら起こす。マージ済み・クローズは、あとから変わらないのでその場で返す
    const outcome = waitOutcome(ci, now, now)
    if (outcome === 'merged' || outcome === 'closed') return { result: outcome, failing: ci.failing.slice(0, WAIT_FAILING_MAX), left: left() }
    // await を挟んだので、数の上限はもう一度見る（ツールを並べて呼ばれても超えない）
    const again = waitLimitRefusal(waits.of(id), repo, made.pr)
    if (again) return { status: 429, error: again }
    const wait: WaitState = {
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      repo,
      pr: made.pr,
      then: made.then,
      status: 'waiting',
      since: waitIso(now),
      deadline: waitIso(now + WAIT_MAX_MS),
      checked_at: waitIso(now),
      next_check_at: waitIso(now + WAIT_POLL_MS),
      url,
      ...(outcome === 'success' || outcome === 'failure' ? { seen_once: outcome } : {}),
    }
    // 同じ PR の、自動では起こさないまま残っていた待ちは置き換える（結果は古くなっている）
    for (const old of waits.of(id).filter((w) => waitReplaceable(w, repo, made.pr))) {
      waits.remove(id, old.id)
      waitRetryAt.delete(old.id)
      waitHeldFor.delete(old.id)
    }
    waits.add(id, wait)
    await waitLog(id, `PR #${made.pr}（${repo}）の CI を待つ（${wait.deadline} まで）`)
    syncWaitTimer()
    return { wait: waits.snapshot()[id]!.find((w) => w.id === wait.id)!, left: left() }
  }

  /**
   * 「待つと言ったが予定なし」の印（#732 の案 3）を、そのターンについてはもう出さない（鍵はエンティティと最後のターン完了の時刻）。
   * 人が待ちを置いた・止めたとき。メモリだけ（立て直すと、12 時間以内のターンには出し直る）
   */
  const waitUnsetHandled = new Set<string>()
  const markWaitUnsetHandled = (session: Pick<SessionSummary, 'id' | 'last_turn_ts'>) => {
    if (!session.last_turn_ts) return
    if (waitUnsetHandled.size > 500) waitUnsetHandled.clear()
    waitUnsetHandled.add(`${session.id}\n${session.last_turn_ts}`)
  }

  /**
   * そのセッションのブランチから出ている open な PR の番号（#732 の案 3）。**リクエストからは受けず、セッションの行から引く**。
   * `fresh` でなければ前に読んだ一覧だけを見る（無ければ裏で読みに行き、今回は「分からない」）。分からなければ `null`
   */
  const branchPrs = async (session: Pick<SessionSummary, 'remote' | 'branch'>, fresh: boolean): Promise<number[] | null> => {
    const repo = githubRepoOf(session.remote)
    if (!repo || !session.branch || !prs.available) return null
    const list = fresh ? await prs.list(repo, true).catch(() => null) : prs.cached?.(repo, HOLDING_PR_STALE_MS)
    if (!list) return null
    // `prForSession()` と同じ線: fork のブランチから出た PR（同じ名前の他人のブランチ）と、既定のブランチにいるセッションは結ばない
    return list.filter((one) => one.head === session.branch && one.base !== session.branch && !one.cross).map((one) => one.number)
  }

  /**
   * 人が画面から「この PR の CI を待つ」を置く（`/wait/add`。#732 の案 3）。**PR はそのセッションのブランチの open な PR から機械で引く**
   * （番号はリクエストから受けない。ちょうど 1 つに決まらなければ置かない）。置き場・上限・断る線はエージェントの口と同じ
   */
  const addWaitByHuman = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
    const session = sessions.find((s) => s.id === id)
    if (!session) return error(res, 404, 'session not found in window')
    if (agents.isStopped(id)) return error(res, 409, 'このセッションからの送信を止めているので、待ちも置けません')
    // ループが組まれているセッションは、次の周で起きる（待ちを重ねて起こさない。エージェントの口と同じ向き）
    if (loopLive(loops.get(id)?.status ?? 'done')) return error(res, 409, 'ループが組まれているセッションには待ちを置けません（次の周で起きます）')
    const blocked = await loopRefusal(session, 'wait')
    if (blocked) return error(res, 400, blocked)
    if (!githubRepoOf(session.remote)) return error(res, 400, 'このセッションのリポジトリ（origin）が GitHub のものと分からないので、PR を確かめられません')
    if (!prs.available || !prs.ci) return error(res, 400, 'gh を使わない設定（SAI_GH=0）なので、CI を確かめられません')
    if (!session.branch) return error(res, 400, 'このセッションのブランチが分からないので、PR を引けません')
    const found = await branchPrs(session, true)
    if (!found) return error(res, 400, 'このセッションのブランチの PR を gh で読めませんでした')
    if (found.length !== 1) return error(res, 400, found.length === 0 ? `ブランチ ${session.branch} から出ている open な PR がありません` : `ブランチ ${session.branch} から出ている PR が ${found.length} 件あり、どれを待つか決められません`)
    const placed = await depositWait(id, session, { pr: found[0]!, then: WAIT_HUMAN_THEN }, selfUrl(req))
    if ('error' in placed) return error(res, placed.status, placed.error)
    // もう終わっていた（マージ済み・クローズ）: 置くものが無い
    if (!placed.wait) return error(res, 409, `PR #${found[0]} はもう${placed.result === 'merged' ? 'マージされています' : '閉じられています'}（待つものがありません）`)
    markWaitUnsetHandled(session)
    const payload: WaitActionResponse = { id, waits: waits.snapshot()[id] ?? [] }
    return json(res, payload)
  }

  /**
   * 人が待ちを止める（`/wait/stop`）・いま起こす（`/wait/wake`）（#732）。**同一オリジンのみ**（起こすと CLI が動く）。
   * 止めるは、状態に関係なくその待ちを消す（終わった・起こせなかった待ちの片付けも同じ口）。
   * いま起こすは、使用量の枠と 1 日の回数だけを越える。処理中・前の返信の失敗・端末で開いているは越えない。
   * 待ち始めてから長く経って終わった待ち（`late`）を起こすのはこの口だけ
   */
  const waitAction = async (req: IncomingMessage, res: ServerResponse, id: string, suffix: (typeof WAIT_SUFFIXES)[number]) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    if ((req.method ?? 'GET') !== 'POST') return error(res, 405, 'method not allowed')
    if (suffix === '/wait/add') return await addWaitByHuman(req, res, id)
    let body: unknown
    try {
      body = await readJson(req, MAX_REPLY_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const waitId = (body as Partial<WaitActionRequest> | null)?.wait
    const cur = typeof waitId === 'string' ? waits.get(id, waitId) : undefined
    if (!cur) return error(res, 404, 'その待ちはありません（もう起こしたか、止めてあります）')
    if (suffix === '/wait/stop') {
      // 止めたあとに「待つと言ったが予定なし」の印を出し直さない（人がいま要らないと決めた）
      const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
      const stopped = sessions.find((s) => s.id === id)
      if (stopped) markWaitUnsetHandled(stopped)
      waits.remove(id, cur.id)
      waitRetryAt.delete(cur.id)
      waitHeldFor.delete(cur.id)
      await waitLog(id, `PR #${cur.pr}: 人が止めた`)
    } else {
      if (!waitWakeable(cur.status)) return error(res, 409, cur.status === 'waking' ? 'いま起こしています' : 'この待ちは起こせません（片付けてください）')
      const why = await wakeWait(id, cur.id, true)
      if (why) return error(res, 409, why === 'retry' ? 'いまは起こせません。少し待ってからもう一度押してください' : why)
    }
    syncWaitTimer()
    const payload: WaitActionResponse = { id, waits: waits.snapshot()[id] ?? [] }
    return json(res, payload)
  }

  /** タイマーを消す（`dispose()` から） */
  const stopWaitTimer = (): void => {
    if (waitTimer) clearInterval(waitTimer)
  }

  return { tickWaits, syncWaitTimer, stopWaitTimer, agentWaitFor, waitAction, waitUnsetHandled, branchPrs }
}
