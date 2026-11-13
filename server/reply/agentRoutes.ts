// セッション同士のメッセージ（#310 / #311）の口と時計。`server/app.ts` の `createApp()` から外に出した区分（#810）。
// `createAgentRoutes(ctx)` は関数を作って返すだけで、時計は立てない（前のサーバが残した預かりを送り始めるのは、`createApp()` が今までの位置で呼ぶ `scheduleBacklog()`）。
// 状態の持ち主（処理中・預かり・起動中の印・送り元が一覧で見た量など）は `createApp()` のままで、ここには参照が来る
import { appendFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { AGENT_SEND_MAX, AGENT_TEXT_MAX_CHARS, AGENT_TURN_READ_BUDGET, AGENT_BACKLOG_ROUND_MS, AGENT_REQUEST_MAX, requestRefusal, agentEntry, agentOverlap, acrossEntry, acrossLabel, acrossNames, targetNames, isAcross, deliveredId, deliveryMatcher, HANDED_KEEP_DAYS, splitHandedReplies, replierName, agentTargets, budgetRefusal, clipReply, deliveredText, isDeliveryOf, replyOf, resolveTarget, targetRefusal, sessionLabel, tokensLabel, usageRefusal } from '../../shared/agentMessages.ts'
import type { PendingReply } from '../../shared/agentMessages.ts'
import { agentWaitCount, agentWaitShown, answeredIds } from '../../shared/agentWaiting.ts'
import { idleMsSince, messageCompacts, startsNewWork } from '../../shared/compact.ts'
import { CONTEXT_WARN_TOKENS } from '../../shared/contextSize.ts'
import { grownRefusal, grownSinceSeen, holdingOf, prOfBranch, startRefusal } from '../../shared/holding.ts'
import { isRemoteHost } from '../../shared/host.ts'
import { githubRepoOf, knownRepos, pickKnownRepo } from '../../shared/prs.ts'
import { replyFailureText } from '../../shared/reply.ts'
import type { AgentActivity, AgentWaitingMap, ReplyQueueMap, AgentHeldMessage, PrSummary, HoldingWhy, SessionHolding, AgentSendManyResponse, AgentSendResult, AgentActivityMessage, AgentStopResponse, AgentSendRequest, AgentSendResponse, AgentSessionsResponse, AgentWaitResponse, ReplyError, ReplyingMap, ReplyResponse, SessionSummary } from '../../shared/types.ts'
import { isWaitPrompt } from '../../shared/waits.ts'
import { AGENT_POLL_MS, HOLDING_PR_STALE_MS, MAX_REPLY_BYTES, QUEUE_DAYS } from '../appContext.ts'
import type { AppContext } from '../appContext.ts'
import { WAIT_MS } from '../approvals/approvals.ts'
import type { Digester } from '../digest/digest.ts'
import { changedPaths, workState } from '../git/diff.ts'
import type { Git } from '../git/diff.ts'
import { mergedKey } from '../git/prs.ts'
import { selfHost } from '../host.ts'
import { backgroundLive } from '../local/claudeAgents.ts'
import type { AgentList, ClaudeAgent } from '../local/claudeAgents.ts'
import { sessionOf } from '../local/progress.ts'
import { entityId } from '../rows/aggregate.ts'
import { createAfterTurns } from './agentAfter.ts'
import { AGENT_MESSAGES_KEEP, AGENT_TOKEN_HEADER, tokenMatches } from './agentMessages.ts'
import type { AgentMessage } from './agentMessages.ts'
import { daemonOccupied } from './codexDaemon.ts'
import type { CodexDaemonWatch, DaemonThreadState } from './codexDaemon.ts'

/** 送ったメッセージが生きていない（相手の預かりにも回っているターンにも無い）まま返答が来なければ、これで失敗に決める（#823。返答の行の遅れを待つ） */
export const AGENT_GONE_MS = 60_000
/** 上のまま返答が来なければ、これで失敗に決めて覚え、返答の行を探すのをやめる（#825 のレビュー。返答が遅れて来たら返答ありに戻せるあいだ） */
export const AGENT_GONE_SETTLE_MS = 24 * 60 * 60_000
/** `overlap`（#564）の材料を覚える時間 */
export const CHANGED_PATHS_TTL_MS = 30_000
/** `sai_sessions` の行に PR を足すとき、まだ 1 回も引いていないリポジトリを待つ長さ（#727。前の結果があれば待たない） */
export const HOLDING_PR_WAIT_MS = 1500
/**
 * 着手の依頼を送る時点の 1 人ぶんの確かめ（`opts.only`）で、PR の状態を `gh` に待つ長さ（#828）。PR の多いリポジトリでは、
 * マージ済みの一覧と head の親を合わせて 2 秒ほどかかり、一覧と同じ 1.5 秒では「引けない」に倒れていた。1 人ぶんなので gh を起こす数は増えない
 */
export const HOLDING_SEND_PR_WAIT_MS = 5000
/** 同じブランチのマージ済みの PR の head の親を、何本まで引くか（#821。ふつうは 1 本。新しい順に見る） */
export const MERGED_PARENTS_MAX = 3
/** 「頼まれて未完」を数える依頼の新しさ（日。#727）。返答の来なかった古い依頼を、いつまでも頼まれ中に数えない */
export const HOLDING_ASK_DAYS = 2

/** 区分が使う `createApp()` の値。`AppContext` のうちの使うものと、この区分だけが使うもの */
export type AgentRoutesContext = Pick<
  AppContext,
  'store' | 'run' | 'launching' | 'typed' | 'queue' | 'agents' | 'prs' | 'progress' | 'codexApp' | 'opencodeApp' | 'usageStore' | 'settingsStore' | 'seenContext' | 'loopNow' | 'launch' | 'sessionsWithMeta' | 'rowsNow' | 'json' | 'error' | 'readJson' | 'isCrossOrigin' | 'selfUrl'
> & {
  /** `agent-token` のファイルの中身（`/api/agent/*` が要る） */
  agentToken: string
  git: Git
  /** `claude agents --json`（`claude --bg` の様子） */
  claudeAgents: AgentList
  /** 共有の app-server を読むだけで見る口（#848）。無ければ undefined */
  codexDaemon: CodexDaemonWatch | undefined
  noteDaemonGap: (id: string, known: HoldingWhy | '', seen: DaemonThreadState | undefined) => void
  /** 生きている `claude --bg` を、いま止められない理由（`launch()` と同じ判定）。止められれば空 */
  backgroundHold: (bg: ClaudeAgent, session: SessionSummary) => Promise<string>
  /** いま sai_wait で待っているメッセージ → 最後に見た時刻（#607） */
  waitedAt: Map<string, number>
  scanDigest: (days: number) => Promise<void>
  digestOffIds: () => Promise<Set<string>>
  digest: Digester
}

export function createAgentRoutes(ctx: AgentRoutesContext) {
  const { store, run, launching, typed, queue, agents, prs, progress, codexApp, opencodeApp, usageStore, settingsStore, seenContext, loopNow } = ctx
  const { launch, sessionsWithMeta, rowsNow, json, error, readJson, isCrossOrigin, selfUrl } = ctx
  const { agentToken, git, claudeAgents, codexDaemon, noteDaemonGap, backgroundHold, waitedAt, scanDigest, digestOffIds, digest } = ctx

  /**
   * エージェント用の口（`/api/agent/*`）に通してよいか。通さないなら理由。
   * **ブラウザからは通さない**（`Origin` / `Sec-Fetch-Site` が付いていれば断る。画面の返信の口とは逆）うえで、
   * `agent-token` のファイルの中身を要る。ブラウザはこのファイルを読めないので、同一オリジンの画面も tailnet 経由も叩けない
   */
  const agentRefusal = (req: IncomingMessage): string => {
    if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) return 'ブラウザからは使えません'
    if (!tokenMatches(agentToken, req.headers[AGENT_TOKEN_HEADER])) return 'トークンが合いません'
    return ''
  }

  /**
   * 送り元を確かめる。**SAI が起動して、いまそのターンを回しているセッションだけ**（最初の PR は Claude の `-p` の返信。
   * MCP サーバは SAI が `--mcp-config` で渡したときだけ動き、送り元はその `SAI_ENTITY`）。失敗して残っているだけのものは除く
   */
  const agentFrom = async (from: unknown): Promise<{ session: SessionSummary; sessions: SessionSummary[]; turn: string } | string> => {
    if (typeof from !== 'string' || !from) return 'from が無い'
    const turn = run.snapshot()[from]
    if (!turn || turn.failed || !run.running(from)) return '送り元のセッションは、SAI から起動したターンを回していません'
    const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
    const session = sessions.find((s) => s.id === from)
    if (!session) return '送り元のセッションが見つかりません'
    return { session, sessions, turn: turn.since }
  }

  /**
   * worktree で変わっているファイル（#564 の `overlap`）。**ツールが呼ばれたときだけ**読み（ポーリングには乗せない）、
   * `(cwd, last_turn_ts)` で `CHANGED_PATHS_TTL_MS` だけ覚える。時間でも切るのは、呼んだ側はターンの途中で編集していて
   * `last_turn_ts` が変わらないため。cwd は行から取り、リクエストからは受けない
   */
  const changedCache = new Map<string, { at: number; paths: Promise<{ root: string; paths: string[] }> }>()
  const changedOf = (s: SessionSummary): Promise<{ root: string; paths: string[] }> => {
    if (!s.cwd || isRemoteHost(s.host, selfHost())) return Promise.resolve({ root: '', paths: [] })
    const key = `${s.cwd}\0${s.last_turn_ts ?? ''}`
    const hit = changedCache.get(key)
    if (hit && Date.now() - hit.at < CHANGED_PATHS_TTL_MS) return hit.paths
    const paths = changedPaths(git, s.cwd).catch(() => ({ root: '', paths: [] as string[] }))
    for (const [k, v] of changedCache) if (Date.now() - v.at >= CHANGED_PATHS_TTL_MS) changedCache.delete(k)
    changedCache.set(key, { at: Date.now(), paths })
    return paths
  }

  /**
   * 生きている `claude --bg` が掴んでいて、いま止められないセッションか（#795。attach している端末がある・ターンが回っている）。
   * 判定は `launch()` と同じ `backgroundLive()` / `backgroundHold()`。止められる bg（誰も開いておらず、ターンも回っていない）は false。
   * `claude agents` に聞けなかったときも false（`launch()` もそのとき bg として扱わない。同じ答えにする）
   */
  const backgroundHeld = async (s: SessionSummary): Promise<boolean> => {
    if (s.agent !== 'claude' || !claudeAgents.background) return false
    const raw = sessionOf(s)
    if (!raw) return false
    const bg = await claudeAgents.background(raw).catch(() => undefined)
    return Boolean(bg && backgroundLive(bg) && (await backgroundHold(bg, s)) !== '')
  }

  /**
   * SAI が渡す口（`sai_sessions` と `sai_send`）から見た「いま持っているもの」（#795）。**一覧の印も、送る時点の確かめも、ここを通す**
   * （材料を別々に組まない）。処理中（端末で人が回しているターンも。transcript の上で動いていれば）・待ち・預かりがあれば空きではない。
   * **ここでは端末と許可の走査を回さない**（画面の走査の結果を、同じリポジトリの相手だけの結果で上書きしないため）。
   * 待ちは行の `waiting` のまま見るので、端末で答えた直後は少しの間「空きではない」側に倒れる
   */
  const agentBusy = (id: string) => run.running(id) || codexApp.running(id) || opencodeApp.running(id) || typed.running(id)
  const agentHoldingsOf = async (list: readonly SessionSummary[], opts: { prs?: boolean; draining?: boolean; only?: string } = {}): Promise<Map<string, SessionHolding>> => {
    const active = new Map(await Promise.all(list.map(async (s) => [s.id, Boolean((await progress.read(s)).active)] as const)))
    const queued = queue.snapshot()
    return holdingsOf(list, (s) => agentOccupied(s, Boolean(active.get(s.id)), queued), () => true, opts)
  }
  /**
   * 着手の形の依頼（1 行目が `#N に着手してください。`）を、いまの相手に送ってよいか（#795）。よければ空、だめなら送り元へ返す文。
   * 見るのは一覧の印と同じ `holding.free`（`holdings` は一覧と同じ道で組んだもの）と、送り元が一覧で見た量からの増え方。
   * 着手の形でない依頼（質問・「マージして」）はここを通さない（今までどおり送る・預かりに並ぶ）
   */
  const startAskRefusal = (holding: SessionHolding | undefined, context: number, seen: number, hidden: boolean): string => {
    // 組めなかった（走査が落ちた）ときも、空きとは言えないので送らない
    if (!holding?.free) return startRefusal(holding?.why ?? 'unknown', hidden)
    if (!hidden && grownSinceSeen(seen, context)) return grownRefusal(tokensLabel(seen), tokensLabel(context))
    return ''
  }

  /**
   * セッションがいま何を持っているか（#727 の案 D の読む側）。`sai_sessions` の 2 つの口（SAI が渡す `sai` と tailnet の `/mcp`）が
   * 1 行に足す。**SAI は持ち場を書いて持たない**: ブランチ・open な PR・届いている依頼から機械で引けるものだけ。
   * - PR は記録で知っているリポジトリ（セッションの remote）だけを、`gh pr list` の決まった形で読む。**応答を待たせない**:
   *   前の結果があればそれを返し（古ければ裏で引き直す）、まだ 1 回も引いていないときだけ `HOLDING_PR_WAIT_MS`（送る時点の 1 人ぶんの確かめは `HOLDING_SEND_PR_WAIT_MS`。#828）待つ。
   *   引けなくても行は落とさない（PR の印が付かないだけ）
   * - 頼まれて未完の依頼は、`HOLDING_ASK_DAYS` 日以内に届けたメッセージのうち、返答（そのターンの完了の行）がまだ無いものと、
   *   まだ送っていない預かり。行は 1 回だけ舐める
   */
  const holdingsOf = async (list: readonly SessionSummary[], occupied: (s: SessionSummary) => HoldingWhy | '', sendable: (s: SessionSummary) => boolean = () => true, opts: { prs?: boolean; draining?: boolean; only?: string } = {}): Promise<Map<string, SessionHolding>> => {
    // 同じリポジトリを書き方の違い（大文字小文字）で 2 回引かない（#533 と同じ。PR の画面が埋めたキャッシュとも揃う）
    const known = knownRepos(list)
    // 送る時点の 1 人ぶんの確かめ（#828）だけ長く待つ。一覧（3 秒のポーリングで引かれる）は短いまま
    const prWait = opts.only !== undefined ? HOLDING_SEND_PR_WAIT_MS : HOLDING_PR_WAIT_MS
    // `gh` で PR を引くリポジトリか（#828。引こうとして引けなかったのか、引きようがないのかを分ける）
    const ghRepo = (asked: string): string => (asked && prs.available && opts.prs !== false ? pickKnownRepo(known, asked) || asked : '')
    const repos = new Map<string, Promise<PrSummary[] | null | undefined>>()
    const prsOf = (asked: string): Promise<PrSummary[] | null | undefined> => {
      const repo = asked ? pickKnownRepo(known, asked) || asked : ''
      if (!repo || !prs.available || opts.prs === false) return Promise.resolve(null)
      const before = repos.get(repo)
      if (before) return before
      const hit = prs.cached?.(repo, HOLDING_PR_STALE_MS)
      let timer: NodeJS.Timeout | undefined
      const job =
        hit !== undefined
          ? Promise.resolve(hit)
          : Promise.race([
              prs.list(repo).catch(() => null),
              new Promise<null>((done) => {
                timer = setTimeout(() => done(null), prWait)
                timer.unref()
              }),
            ]).finally(() => clearTimeout(timer))
      repos.set(repo, job)
      return job
    }
    // マージ済みの PR の head（#795）。応答を gh に待たせない（open の一覧と同じ長さだけ待ち、間に合わなければ「引けない」）。
    // 待つ長さは、マージ済みの一覧と head の親（#821）を合わせて `prWait` まで。
    // `yes` = マージ済みのブランチが残っているだけ、`no` = そうではない（引きようがない も含む）、`unknown` = gh が時間切れ・失敗で確かめられない（#828）
    const mergedLeftover = async (s: SessionSummary, asked: string): Promise<'yes' | 'no' | 'unknown'> => {
      const repo = ghRepo(asked)
      const branch = s.branch ?? ''
      if (!repo || !branch || !prs.mergedHeads) return 'no'
      const deadline = Date.now() + prWait
      const within = <T,>(job: Promise<T | null>): Promise<T | null> => {
        let timer: NodeJS.Timeout | undefined
        return Promise.race([
          job.catch(() => null),
          new Promise<null>((done) => {
            timer = setTimeout(() => done(null), Math.max(0, deadline - Date.now()))
            timer.unref()
          }),
        ]).finally(() => clearTimeout(timer))
      }
      const heads = await within(prs.mergedHeads(repo))
      if (!heads) return 'unknown'
      const head = await git.run(s.cwd, ['rev-parse', 'HEAD']).then((out) => out.trim()).catch(() => '')
      if (head === '') return 'no'
      if (heads.has(mergedKey(branch, head))) return 'yes'
      // GitHub 上で base を取り込んでからマージされた PR（#821。「Update branch」など）: head は手元に無い取り込みのコミットで、
      // 手元の HEAD の 1 つ先。**親が 2 つで、1 つ目がいまの HEAD** なら、足りないのは GitHub が作った取り込みだけ（手元の HEAD より
      // 先に作りかけは無い）。2 つ目の親が base 側かは見ない（手元に無いことが多く、見ても手元の作りかけの有無は変わらない）。
      // 親を引くのは、ここまで来た（作りかけに見え、open な PR も無い）セッションの、同じブランチのマージ済みの head だけ
      const prefix = mergedKey(branch, '')
      const candidates = [...heads].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).slice(0, MERGED_PARENTS_MAX)
      if (candidates.length === 0 || !prs.commitParents) return 'no'
      let missed = false
      for (const sha of candidates) {
        const parents = await within(prs.commitParents(repo, sha))
        if (parents && parents.length === 2 && parents[0] === head) return 'yes'
        if (!parents) missed = true
      }
      return missed ? 'unknown' : 'no'
    }
    // 返答の済んだメッセージの id（行を 1 回だけ舐める。見るのは依頼の新しさの分だけ）
    const notBefore = Date.now() - HOLDING_ASK_DAYS * 86_400_000
    const pending = new Map<string, AgentMessage[]>()
    for (const s of list) {
      const got = agents.sentTo(s.id, notBefore)
      if (got.length > 0) pending.set(s.id, got)
    }
    const replied = new Set<string>()
    if (pending.size > 0) {
      const matcher = deliveryMatcher()
      for (const row of await rowsNow(HOLDING_ASK_DAYS + 1)) {
        const id = deliveredId(matcher.headOf(row))
        if (id) replied.add(`${entityId(row.session ?? '', row.repo ?? '', String(row.ts ?? ''))}\0${id}`)
      }
    }
    // いま回っているターン（どの経路でも。読むだけで、片付けや配送の確かめは回さない）
    const turns: ReplyingMap = { ...typed.snapshot(), ...run.snapshot(), ...codexApp.replying(), ...opencodeApp.replying() }
    const out = new Map<string, SessionHolding>()
    await Promise.all(
      list.map(async (s) => {
        // 未完に数えるのは、返答がまだ無く、**まだ生きている**依頼だけ: 相手の預かりに並んでいるか、相手がいまターンを回している。
        // 失敗した・人が止めた・預かりから取り消された依頼（返答の行が来ない）を、いつまでも頼まれ中に数えない
        // 「回している」は、**その依頼で回っているターン**（いまのターンの入力が、その依頼の見出しを持つ）のときだけ。
        // 相手が別のターンを回しているだけでは、前に死んだ依頼を生き返らせない。端末に打ち込んだ依頼（`typed`）も同じ形で見る
        const inQueue = new Set(queue.origins(s.id))
        const turn = turns[s.id]
        const live = (m: AgentMessage) => inQueue.has(m.message_id) || (turn !== undefined && !turn.failed && isDeliveryOf(turn.text, m.message_id))
        const asks = [
          ...(pending.get(s.id) ?? []).filter((m) => !replied.has(`${s.id}\0${m.message_id}`) && live(m)).map((m) => m.text),
          // 預かりを送る直前の確かめ（`opts.draining`）では、**まだ送っていない預かりを数えない**（#795 のレビュー。数えると、いま送ろうと
          // している 1 件が自分で、または同じ相手宛ての後ろの預かりで「頼まれ中」になって必ず止まる）。先に送った 1 件が相手を起こせば、
          // 後ろの着手の依頼は「処理中」「頼まれ中」（相手の預かり・回っているターン）で止まる
          ...(opts.draining ? [] : agents.heldFor(s.id).map((h) => h.text)),
        ]
        const remote = isRemoteHost(s.host, selfHost())
        const repo = remote ? '' : githubRepoOf(s.remote)
        const can = sendable(s)
        // 空きでない理由（#795）。回っているターン・待ち・預かりは呼び出し側が見たもの。ここで足すのは、起動中・止められない
        // `claude --bg`（attach 中・ターン中。`launch()` が預かって待つのと同じ判定）と、worktree の作りかけ。
        // **git と `claude agents` を読むのは、ほかの理由が無い、このマシンの頼める相手だけ**（理由は最初の 1 つしか出さない）
        const judged: HoldingWhy | '' = occupied(s) || (launching.has(s.id) ? 'busy' : '')
        // daemon が見ている状態（#848）。言えるのは「空きでない」だけで、`idle` は空きの証拠にしない。今の判定と食い違ったら数える（古い道を消す材料）
        const seen = s.agent === 'codex' ? codexDaemon?.state(sessionOf(s)) : undefined
        noteDaemonGap(s.id, judged, seen)
        const first: HoldingWhy | '' = judged || daemonOccupied(seen)
        // `opts.only` があれば、その 1 件だけ読む（送る時点の確かめ。使うのはその相手の答えだけなので、ほかの相手の worktree に git を回さない）
        const look = can && !remote && !first && asks.length === 0 && (opts.only === undefined || opts.only === s.id)
        const held = look && (await backgroundHeld(s)) ? 'background' : ''
        const open = await prsOf(repo)
        let work = look && !held ? await workState(git, s.cwd) : undefined
        // base に入っていないコミットがあり、open な PR も無い: **マージ済みの PR の head がいまの HEAD そのもの**なら、
        // マージ済みのブランチが残っているだけ（squash マージではコミットが base に届かず、base がそのファイルをあとで変えると
        // git だけでは見分けられない）。違うなら作りかけの側のまま。
        // gh で確かめようとして時間切れ・失敗した（open な PR の一覧・マージ済みの head・その親）なら、空きにしないまま理由を分ける（#828）
        let prUnknown = false
        if (work === 'ahead' && ghRepo(repo)) {
          if (open === null) prUnknown = true
          else if (!prOfBranch(open, s.branch ?? '')) {
            const left = await mergedLeftover(s, repo)
            if (left === 'yes') work = 'clean'
            else prUnknown = left === 'unknown'
          }
        }
        out.set(s.id, holdingOf({ branch: s.branch ?? '', prs: open, asks, occupied: first || held, sendable: can, prUnknown, ...(work ? { work } : {}) }))
      }),
    )
    return out
  }

  /**
   * GET /api/agent/sessions?from=。話しかけられる相手（同じ project の、返信できる別のセッション）。
   * 人が許した組の先の、**別のリポジトリのセッション**（#747）も後ろに並べる。そちらは呼び名・エージェント・空いているか、まで
   */
  const agentSessions = async (req: IncomingMessage, res: ServerResponse, q: URLSearchParams) => {
    const refusal = agentRefusal(req)
    if (refusal) return error(res, 403, refusal)
    const found = await agentFrom(q.get('from'))
    if (typeof found === 'string') return error(res, 409, found)
    const busy = agentBusy
    const across = (await settingsStore.get()).send_across
    const everyone = agentTargets(found.sessions, found.session, selfHost(), across)
    // 細かく出すのは同じリポジトリの相手だけ（読み直す量・同じファイル・持っているもの）
    const targets = everyone.filter((s) => !isAcross(found.session, s, across))
    const others = everyone.filter((s) => isAcross(found.session, s, across))
    // 相手が読み直す量（直近の呼び出しの入力）。transcript の末尾を読むだけで、(mtime, size) が同じなら組み直さない（#311）
    const progressOf = await Promise.all(targets.map((s) => progress.read(s)))
    const sizes = progressOf.map((p) => p.context_tokens)
    // 同じファイルを触っているか（#564）。知らせるだけで、送るかはエージェントが決める
    const [mine, ...theirs] = await Promise.all([changedOf(found.session), ...targets.map(changedOf)])
    // いま何を持っているか（#727）。送る時点の確かめ（#795）と同じ道（`agentHoldingsOf()`）で組む
    const active = new Map(targets.map((s, i) => [s.id, Boolean(progressOf[i]?.active)]))
    const holdings = await agentHoldingsOf(targets)
    // 別のリポジトリの相手は、空いているかだけ（走査は回さない。理由も PR も出さない。PR は空きの判定に使うために読むだけ。#795）
    const otherHoldings = await agentHoldingsOf(others)
    // 送り元が見た量を覚える（#795。着手の依頼を送る時点で、ここから大きく増えていたら送らない）
    seenContext.set(found.session.id, new Map(targets.map((s, i) => [s.id, sizes[i] ?? 0])))
    const payload: AgentSessionsResponse = {
      from: found.session.id,
      sessions: [...targets.map((s, i) => {
        const entry = agentEntry(s, busy(s.id), sizes[i] ?? 0, agentOverlap(mine ?? { root: '', paths: [] }, theirs[i] ?? { root: '', paths: [] }), active.get(s.id) || s.waiting ? undefined : loopNow())
        const holding = holdings.get(s.id)
        return holding && Object.keys(holding).length > 0 ? { ...entry, holding } : entry
      }), ...others.map((s) => acrossEntry(s, busy(s.id), Boolean(otherHoldings.get(s.id)?.free)))],
    }
    return json(res, payload)
  }

  /**
   * メッセージを要約（`/compact`）してから始めさせるか（#624）。画面からの送信と同じ判定で、渡すのは**見出しを付ける前の文**
   * （着手の形かの判定も、`/compact` に添える指示もそこから作る）。間（#761）は相手の最後のターン完了の行から数えるが、既定には効かない（要約が既定になるのは着手の形だけ。2026-10-15）。相手が処理中・預かりがあるときは `launch()` が今までどおり
   * 預かりに並べる（画面からの送信と同じ。並んだものの前に要約は挟まない）
   */
  const messageCompactOf = (target: SessionSummary, text: string, contextTokens: number, asked: unknown): { compact?: true; compactFrom?: string } =>
    messageCompacts({ text, agent: target.agent, contextTokens, terminal: Boolean(target.terminal), idleMs: idleMsSince(target.last_turn_ts, loopNow()) }, CONTEXT_WARN_TOKENS, typeof asked === 'boolean' ? asked : undefined)
      ? { compact: true, compactFrom: text }
      : {}

  /**
   * POST /api/agent/send。別のセッションに送る（#310）。相手が処理中なら預かり（#305）に並ぶ。
   * 断るのは: トークン・送り元がターンを回していない・相手が同じ project の返信できるセッションでない（403）、
   * 受け取ったメッセージで回っているターンから（連鎖）・1 ターンの回数を超えた（429。#311）
   */
  const agentSend = async (req: IncomingMessage, res: ServerResponse) => {
    const refusal = agentRefusal(req)
    if (refusal) return error(res, 403, refusal)
    let body: unknown
    try {
      body = await readJson(req, MAX_REPLY_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const b = (body ?? {}) as Partial<AgentSendRequest>
    // **同じ送り元からの送信は 1 つずつ通す**（#727 のレビュー）。エージェントがツールを並べて呼ぶと、どの呼び出しも
    // 「まだ 0 回」を見てしまい、回数の上限も依頼の上限も数え損ねる（預かりの順も崩れる）
    const key = typeof b.from === 'string' ? b.from : ''
    const before = sendLocks.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const mine = before.then(() => new Promise<void>((done) => (release = done)))
    sendLocks.set(key, mine)
    await before
    try {
      return await agentSendOne(req, res, b)
    } finally {
      release()
      if (sendLocks.get(key) === mine) sendLocks.delete(key)
    }
  }
  const sendLocks = new Map<string, Promise<void>>()
  const agentSendOne = async (req: IncomingMessage, res: ServerResponse, b: Partial<AgentSendRequest>) => {
    // 宛先は 1 つ（`to` / `text`）か、1 つの依頼としての複数（`items`。#727）。どちらも同じ道を通す。
    // 空の `items` は付いていないのと同じ（省略できる配列を空で埋めて呼ぶモデルがある）
    const many = b.items !== undefined && !(Array.isArray(b.items) && b.items.length === 0)
    if (many && (!Array.isArray(b.items) || b.items.some((it) => !it || typeof it !== 'object'))) return error(res, 400, 'items は { to, text } の配列で送ってください')
    const asks = many ? b.items!.map((it) => ({ to: it.to, text: it.text, compact: it.compact })) : [{ to: b.to, text: b.text, compact: b.compact }]
    if (asks.length > AGENT_REQUEST_MAX) return error(res, 429, requestRefusal(0, 0, asks.map(() => ({ name: '', tokens: 0 }))))
    const nth = (n: number) => (many ? `${n + 1} 件目: ` : '')
    for (const [n, a] of asks.entries()) {
      const text = typeof a.text === 'string' ? a.text.trim() : ''
      if (!text) return error(res, 400, `${nth(n)}text が要ります`)
      if (text.length > AGENT_TEXT_MAX_CHARS) return error(res, 400, `${nth(n)}送れるのは ${AGENT_TEXT_MAX_CHARS} 字までです。短くまとめてください`)
    }
    const found = await agentFrom(b.from)
    if (typeof found === 'string') return error(res, 409, found)
    const from = found.session.id
    // 待ちで SAI が起こしたターン（#732）からは送らせない（人が見ていない間に、起きたターンが次のターンを起こさない）
    if (isWaitPrompt(splitHandedReplies(run.snapshot()[from]?.text ?? '').text)) return error(res, 429, '待ちで起きたターンからは、別のセッションへ送れません（結果を報告して終えてください）')
    // 人が止めている・受け取ったメッセージで回っているターン（連鎖）からは、預かりもしない（回数はここでは見ない）
    const barred = agents.refusal(from, found.turn, Infinity)
    if (barred) return error(res, 429, barred)
    // 宛先は id か呼び名（#625）。引くのは送ってよい相手の中からだけで、ちょうど 1 つに決まらなければ送らない
    // 送ってよい相手: 同じ project と、人が許した組の先の project（#747）。歯止めは下の同じ判定を通す
    const across = (await settingsStore.get()).send_across
    const targets = agentTargets(found.sessions, found.session, selfHost(), across)
    // 同じ project（と、許した組の先の project）に居るが送れないセッション（別のマシンなど）。同じ名前がそこにも居れば、名前では当てない
    const blocked = found.sessions.filter((s) => s.id !== from && (s.project === found.session.project || isAcross(found.session, s, across)) && !s.archived && !targets.includes(s))
    // **先に全部の宛先を確かめて数える**（#727）。1 つでも通らなければ、1 件も送らず・預からずに断る
    const usageNow = await usageStore.get()
    const planned: { target: SessionSummary; far: boolean; text: string; context: number; compact: boolean | undefined }[] = []
    for (const [n, a] of asks.entries()) {
      const asked = typeof a.to === 'string' ? a.to : ''
      // 別のリポジトリの相手は、id か人が付けた表示名でだけ引く（worktree 名・題名では当てない。#747）
      let resolved = resolveTarget(targets, asked, blocked, (s) => (isAcross(found.session, s, across) ? acrossNames(s) : targetNames(s)))
      // 名前で引いて別のリポジトリの相手に決まったとき、**送り元のリポジトリに同じ名前のセッションが居れば送らない**
      // （アーカイブ済みでも。人が指していたのがそちらかもしれないのに、別のリポジトリへ黙って届かせない）
      if (resolved.target && resolved.target.id !== asked && isAcross(found.session, resolved.target, across)) {
        const key = asked.trim().toLowerCase()
        const local = found.sessions.filter((s) => s.id !== from && s.project === found.session.project && targetNames(s).includes(key)).length
        if (local > 0) resolved = { target: null, ambiguous: true, candidates: [resolved.target], hidden: local }
      }
      if (!resolved.target) {
        return error(res, resolved.ambiguous ? 409 : 403, nth(n) + targetRefusal(asked, resolved, 'その相手には送れません（同じリポジトリか、人が許したリポジトリの、SAI から返信できる別のセッションだけ。sai_sessions で確かめてください）', found.session.project))
      }
      // 使用量の枠が残り少なければ送らない。見るのは相手のエージェントの枠（受け取って読み直すのは相手。#311）
      const overUsage = usageRefusal(usageNow, resolved.target.agent)
      if (overUsage) return error(res, 429, nth(n) + overUsage)
      // 相手の大きさは transcript / rollout の直近の呼び出しの入力
      const context = (await progress.read(resolved.target)).context_tokens
      // 1 件だけで 1 ターンの読み直しの予算を超える相手には、預かっても送れない（1 巡の予算は同じ）。今までどおり断る（#311）
      const far = isAcross(found.session, resolved.target, across)
      const tooBig = budgetRefusal(0, context)
      // 別のリポジトリの相手の量は、断りの文にも出さない（一覧で伏せている。#747）
      if (tooBig) return error(res, 429, nth(n) + (far ? 'この相手は、1 件で 1 ターンの読み直しの予算を超えます（別のリポジトリの相手の量は出しません）。人に確かめてください' : tooBig))
      // **着手の形の依頼は、送る時点で相手が空きでなければ送らない**（#795。一覧が古くても、別の作業の途中に割り込ませない）。
      // 見るのは一覧の印と同じ `holding.free`。相手には何もしない（預かりにも並べない）。無理に送る口は作っていない
      // 1 つの依頼（`items`）の中で、着手の依頼と別の依頼を同じ相手に重ねない（確かめは 1 件も送る前に済ませるので、
      // 重ねると先の 1 件が相手を起こしたあとに、後ろの着手の依頼が空きでない相手の預かりに並ぶ。#795 のレビュー）
      const starts = startsNewWork((a.text as string).trim())
      if (planned.some((p) => p.target.id === resolved.target!.id && (starts || startsNewWork(p.text)))) {
        return error(res, 409, nth(n) + '同じ相手に、着手の依頼とほかの依頼を 1 度に送れません（着手の依頼は、相手が空きのときに 1 件だけ）。分けて送ってください')
      }
      if (starts) {
        const holding = (await agentHoldingsOf([resolved.target], { only: resolved.target.id })).get(resolved.target.id)
        const no = startAskRefusal(holding, context, seenContext.get(from)?.get(resolved.target.id) ?? 0, far)
        if (no) {
          await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${from} → ${resolved.target.id} 着手の依頼を送らなかった（相手が空きでない: ${holding?.why ?? (holding?.free ? '読み直す量が増えた' : 'unknown')}）\n`).catch(() => {})
          return error(res, 409, nth(n) + no)
        }
      }
      planned.push({ far, target: resolved.target, text: (a.text as string).trim(), context, compact: typeof a.compact === 'boolean' ? a.compact : undefined })
    }
    const heldBefore = agents.heldInTurn(from, found.turn)
    const sentBefore = agents.sentInTurn(from, found.turn)
    // この依頼がその場で送り切れるか（1 ターンの回数と読み直しの予算。#311）。送り切れないなら、依頼の上限（#727）を先に見る
    let spent = agents.readInTurn(from, found.turn)
    // 預かりが残っている間は、あとから来た送信も後ろに並べる（前のターンで預かった分を追い越さない）
    let room = agents.heldBy(from).some((h) => !h.halted) ? 0 : Math.max(0, AGENT_SEND_MAX - sentBefore)
    let direct = 0
    for (const p of planned) {
      if (room <= 0 || budgetRefusal(spent, p.context)) break
      room--
      spent += p.context
      direct++
    }
    if (direct < planned.length) {
      const over = requestRefusal(sentBefore + heldBefore.count, agents.readInTurn(from, found.turn) + heldBefore.read, planned.map((p) => ({ name: sessionLabel(p.target), tokens: p.context, ...(p.far ? { hidden: true } : {}) })), agents.hiddenInTurn(from, found.turn) + heldBefore.hidden > 0)
      if (over) return error(res, 429, over)
    }
    const results: AgentSendResult[] = []
    for (const [n, p] of planned.entries()) {
      const to = p.target.id
      const messageId = agents.newId()
      // 別のリポジトリの相手（#747）は、呼び名を題名に落とさず、読み直す量も返さない（予算には数えている）
      const base = { message_id: messageId, to, to_name: p.far ? acrossLabel(p.target) : sessionLabel(p.target), context_tokens: p.far ? 0 : p.context }
      if (n >= direct) {
        // 預かる（#727）。送るのは送り元のターンが終わってから（`drainBacklog()`）
        agents.hold({ message_id: messageId, from, to, text: p.text, turn: found.turn, at: new Date().toISOString(), context: p.context, url: selfUrl(req), ...(p.far ? { far: true as const } : {}), ...(b.wake === true ? { wake: true as const } : {}), ...(p.compact !== undefined ? { compact: p.compact } : {}) })
        await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${from} → ${to} メッセージ ${messageId} を預かった（1 ターンの上限を超えた分。ターンが終わってから送る）\n`).catch(() => {})
        results.push({ ...base, held: true })
        continue
      }
      const delivered = deliveredText({ label: sessionLabel(found.session), project: found.session.project }, messageId, p.text)
      const compact = messageCompactOf(p.target, p.text, p.context, p.compact)
      const out = await launch(to, delivered, [], { days: QUEUE_DAYS, replaceTyped: false, forceProcess: false, url: selfUrl(req), queue: true, origin: messageId, terminalFallback: true, ...compact })
      if (out.status !== 202) {
        // 別のリポジトリの相手（#747）の起動の失敗は、理由を返さない（相手の作業ディレクトリのパスなどが文に入る）。理由は reply.log に残る
        const why = p.far ? '相手のセッションを始められませんでした（別のリポジトリの相手の理由は出しません。人に確かめてください）' : (out.body as ReplyError).error
        if (p.far) await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${from} → ${to} 別のリポジトリへのメッセージを送れなかった: ${(out.body as ReplyError).error}\n`).catch(() => {})
        if (!many) return p.far ? error(res, out.status, why) : json(res, out.body, out.status)
        results.push({ ...base, error: why })
        continue
      }
      const { via, past_terminal, stuck } = out.body as ReplyResponse
      agents.record(
        { message_id: messageId, from, to, text: p.text, since: new Date().toISOString(), turn: found.turn, ...(p.far ? { far: true as const } : {}), ...(b.wake === true ? { wake: true as const, url: selfUrl(req) } : {}) },
        found.turn,
        p.context,
      )
      await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${from} → ${to} メッセージ ${messageId}（${via}）\n`).catch(() => {})
      results.push({ ...base, via, ...(past_terminal ? { past_terminal } : {}), ...(stuck ? { stuck } : {}) })
    }
    const counts = {
      sent: agents.sentInTurn(from, found.turn),
      limit: AGENT_SEND_MAX,
      // 別のリポジトリの相手の分（#747）は、合計からも引いて返す（引き算で相手の量が分からないように。予算には数えている）
      read_tokens: agents.readInTurn(from, found.turn) - agents.hiddenInTurn(from, found.turn),
      read_budget: AGENT_TURN_READ_BUDGET,
    }
    const heldCount = agents.heldBy(from).length
    if (many) {
      const payload: AgentSendManyResponse = { results, ...counts, held_count: heldCount }
      return json(res, payload, 202)
    }
    const one = results[0]!
    const payload: AgentSendResponse = {
      message_id: one.message_id,
      to: one.to,
      to_name: one.to_name,
      ...(one.via ? { via: one.via } : {}),
      ...(one.past_terminal ? { past_terminal: true as const } : {}),
      ...(one.stuck ? { stuck: true as const } : {}),
      ...(one.held ? { held: true as const, held_count: heldCount } : {}),
      ...counts,
      context_tokens: one.context_tokens,
    }
    return json(res, payload, 202)
  }

  /**
   * 預かった送信（#727）を送る。**送り元のターンが終わってから**（回っている間は送らない）、1 巡に `AGENT_SEND_MAX` 件・
   * `AGENT_TURN_READ_BUDGET` まで、巡と巡の間は `AGENT_BACKLOG_ROUND_MS` 空ける。相手のターンが終わったとき・画面のポーリングの
   * ついで・前の巡のタイマーから呼ぶ。
   *
   * - 人が「送信を止める」にしていれば送らない（押したときに預かりごと捨てている）
   * - 送る直前にもう一度確かめる: 相手がまだ送ってよい相手か・相手の使用量の枠。通らなければその 1 件は捨てて `reply.log` に残す
   * - **送る前に送りかけの印を書く**（`beginHeld()`）。印が付いたまま立て直されたら送り直さない
   * - 送り方は `sai_send` と同じ `launch()`（相手が処理中なら相手の預かりに並ぶ。権限のフラグは足さない）
   */
  const backlogRoundAt = new Map<string, number>()
  const backlogTimers = new Map<string, NodeJS.Timeout>()
  let backlogBusy = false
  /** 巡の途中で呼ばれた（別の送り元のターンが終わった、など）。終わったらもう 1 回見る */
  let backlogAgain = false
  const drainBacklog = async (): Promise<void> => {
    if (backlogBusy) {
      backlogAgain = true
      return
    }
    backlogBusy = true
    const log = join(store.directory, 'reply.log')
    try {
      do {
        backlogAgain = false
        const froms = agents.heldFroms().filter((from) => !agents.isStopped(from) && agents.heldBy(from).some((h) => !h.halted))
        if (froms.length === 0) break
        // 一覧と使用量は 1 巡に 1 回だけ取る
        const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
        const usageNow = await usageStore.get()
        for (const from of froms) {
          // 送り元がまだ回っている間は送らない（ターンの終わりがもう一度ここを呼ぶ）
          if (run.running(from)) continue
          const wait = (backlogRoundAt.get(from) ?? 0) + AGENT_BACKLOG_ROUND_MS - Date.now()
          if (wait > 0) {
            scheduleBacklog(from, wait)
            continue
          }
          const sender = sessions.find((x) => x.id === from)
          if (!sender) {
            // 一覧の窓の外に出た送り元。見出しを組めないので送らない（忘れずに残し、時間を置いてもう一度見る）
            scheduleBacklog(from, AGENT_BACKLOG_ROUND_MS)
            continue
          }
          // 預かったあとに人が組を外していれば、その先へはもう送らない（#747）
          const targets = agentTargets(sessions, sender, selfHost(), (await settingsStore.get()).send_across)
          let sentNow = 0
          let readNow = 0
          for (const h of agents.heldBy(from)) {
            if (h.halted) continue
            if (sentNow >= AGENT_SEND_MAX) break
            // 巡の途中で人が「送信を止める」を押した
            if (agents.isStopped(from)) break
            // 送らないと決めた 1 件は捨てずに止めて残す（エージェントには「預かった」と返してあるので、黙って消さない。画面に理由が出る）
            const halt = async (why: string) => {
              agents.haltHeld(h.message_id, why)
              await appendFile(log, `--- ${new Date().toISOString()} ${from} → ${h.to} 預かっていたメッセージ ${h.message_id} は送らなかった: ${why}\n`).catch(() => {})
            }
            try {
              const target = targets.find((x) => x.id === h.to)
              const gone = !target ? '相手がもう送れるセッションではありません' : usageRefusal(usageNow, target.agent)
              if (!target || gone) {
                await halt(gone)
                continue
              }
              const context = (await progress.read(target)).context_tokens
              // 預かったあとに相手が大きくなって、1 件で 1 巡の予算を超えた
              const tooBig = budgetRefusal(0, context)
              if (tooBig) {
                await halt(tooBig)
                continue
              }
              // 預かっている間に相手が空きでなくなった着手の依頼は送らない（#795。送る時点の確かめと同じ判定）
              if (startsNewWork(h.text)) {
                const holding = (await agentHoldingsOf([target], { draining: true, only: target.id })).get(target.id)
                const no = startAskRefusal(holding, context, 0, Boolean(h.far))
                if (no) {
                  await halt(no)
                  continue
                }
              }
              // この巡の予算の残りに入らなければ、次の巡へ
              if (budgetRefusal(readNow, context)) break
              if (!agents.beginHeld(h.message_id)) continue
              const delivered = deliveredText({ label: sessionLabel(sender), project: sender.project }, h.message_id, h.text)
              const compact = messageCompactOf(target, h.text, context, h.compact)
              const out = await launch(h.to, delivered, [], { days: QUEUE_DAYS, replaceTyped: false, forceProcess: false, url: h.url, queue: true, origin: h.message_id, terminalFallback: true, ...compact })
              if (out.status !== 202) {
                await halt(`送れませんでした: ${(out.body as ReplyError).error}`)
                continue
              }
              // 起動を待っている間に人が「送信を止める」を押した（預かりはもう捨てられている）。相手の預かりに並んだだけなら
              // 取り消す（止めた側の取り消しは記録から探すので、まだ記録していないこの 1 件には当たらない）。
              // もう相手で回り始めていたら止めない（相手で回っているターンは止めない）ので、届いたものとして記録する
              if (!agents.heldBy(from).some((x) => x.message_id === h.message_id)) {
                const removed = queue.removeWhere((_to, item) => item.origin === h.message_id)
                if (removed > 0) {
                  await appendFile(log, `--- ${new Date().toISOString()} ${from} → ${h.to} 預かっていたメッセージ ${h.message_id} は、止められたので取り消した\n`).catch(() => {})
                  continue
                }
              }
              // 記録してから預かりを外す（どちらも同じファイル。記録の済んだ預かりは、読み込むときにも捨てる）。
              // 1 ターンの回数・量（`sends`）には足さない（送り元がいま回している別のターンの数を潰さない）
              agents.recordHeld({ message_id: h.message_id, from, to: h.to, text: h.text, since: new Date().toISOString(), turn: h.turn, ...(h.far ? { far: true as const } : {}), ...(h.wake ? { wake: true as const, url: h.url } : {}) })
              agents.dropHeld(h.message_id)
              sentNow++
              readNow += context
              await appendFile(log, `--- ${new Date().toISOString()} ${from} → ${h.to} 預かっていたメッセージ ${h.message_id} を送った（${(out.body as ReplyResponse).via}）\n`).catch(() => {})
            } catch (err) {
              // 途中で落ちた 1 件は、送りかけの印が付いたままになる。届いたか分からないので送り直さず、止めて残す
              await halt(`送っている途中で失敗しました: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
          if (sentNow > 0) backlogRoundAt.set(from, Date.now())
          if (agents.heldBy(from).some((h) => !h.halted)) scheduleBacklog(from, AGENT_BACKLOG_ROUND_MS)
        }
      } while (backlogAgain)
    } catch (err) {
      // 一覧・使用量が読めなかった巡は何もしない（預かりは残る）。タイマーはもう切れているので、掛け直してもう一度見る
      for (const from of agents.heldFroms()) scheduleBacklog(from, AGENT_BACKLOG_ROUND_MS)
      await appendFile(log, `--- ${new Date().toISOString()} 預かったメッセージを送る巡が失敗した: ${err instanceof Error ? err.message : String(err)}\n`).catch(() => {})
    } finally {
      backlogBusy = false
    }
  }
  /** 次の巡を時間で起こす（画面を開いていなくても進むように）。プロセスの終了は待たせない */
  const scheduleBacklog = (from: string, ms: number): void => {
    if (backlogTimers.has(from)) return
    const timer = setTimeout(() => {
      backlogTimers.delete(from)
      void drainBacklog()
    }, Math.max(0, ms))
    timer.unref()
    backlogTimers.set(from, timer)
  }

  /**
   * 送り元（`from`）にまだ渡していない返答（#594）。送ってから `HANDED_KEEP_DAYS` 以内で、相手のターンが終わった・失敗したものだけ（古い順）。
   * まだ返っていない依頼は足さない
   */
  const AGENT_FAR_FAILED = '相手のセッションで失敗しました（別のリポジトリの相手の理由は出しません。人に確かめてください）'
  const pendingRepliesOf = async (from: string, skip?: (messageId: string) => boolean): Promise<{ replies: PendingReply[]; ids: string[] }> => {
    const waiting = agents.unhanded(from, Date.now() - HANDED_KEEP_DAYS * 86_400_000).filter((m) => !skip?.(m.message_id))
    if (waiting.length === 0) return { replies: [], ids: [] }
    // 相手の呼び名。**別のリポジトリの相手は、人が付けた表示名か `#<worktree 名>` だけ**（#747。題名＝相手のリポジトリの人の入力を、
    // 返答の見出しから送り元の文脈へ流さない）。表示名はメタを重ねた一覧から引く（同じリポジトリの相手は今までどおり）
    // 別のリポジトリだったかは送ったときの印（`far`）で見る（いまの行や組から決め直さない）
    const { sessions } = await store.sessions(QUEUE_DAYS)
    const named = waiting.some((m) => m.far) ? (await sessionsWithMeta(QUEUE_DAYS).catch(() => ({ sessions: [] as SessionSummary[] }))).sessions : []
    const nameOf = (m: AgentMessage) => {
      const target = sessions.find((s) => s.id === m.to)
      if (!target) return m.to
      return m.far ? acrossLabel(named.find((s) => s.id === m.to) ?? { ...target, meta: undefined }) : replierName(target)
    }
    const replies: PendingReply[] = []
    for (const m of waiting) {
      const r = await agentResult(m)
      if (!r || r.status === 'pending') continue
      replies.push({ message_id: m.message_id, to_name: nameOf(m), status: r.status, ...(r.text !== undefined ? { text: r.text } : {}), ...(r.error !== undefined ? { error: r.error } : {}) })
    }
    return { replies, ids: replies.map((r) => r.message_id) }
  }

  /** 頼んだ件の「その後」（#827）。別のリポジトリの相手・送り元からのメッセージで起きたターンは添えない */
  const afterOf = createAfterTurns({
    agents,
    rows: () => rowsNow(QUEUE_DAYS),
    sessions: async () => (await store.sessions(QUEUE_DAYS)).sessions,
    lines: async () => {
      await scanDigest(QUEUE_DAYS)
      const off = await digestOffIds()
      return (entity, row) => (off.has(entity) ? '' : (digest.partsFor(entity, row.ts)?.what ?? ''))
    },
    prs,
  })

  /**
   * 送ったメッセージの結果。相手のそのターンが終わっていれば返答、失敗・止まっていれば理由。まだなら null。
   * 別のリポジトリの相手（`far`。#747）の失敗の理由は出さない（reply.log の末尾＝相手の CLI の出力や、相手の cwd が入る）
   */
  const agentResult = async (message: AgentMessage): Promise<AgentWaitResponse | null> => {
    const base = { message_id: message.message_id, to: message.to }
    const replyRow = replyOf(await rowsNow(QUEUE_DAYS), message.to, message.message_id)
    if (replyRow) return { ...base, status: 'done', text: clipReply(replyRow.text ?? '') }
    const failure = agentFailure(message)
    return failure ? { ...base, status: 'failed', error: failure } : null
  }
  /** 送ったメッセージが失敗した・止まったなら、その理由（まだなら空）。返答があるかは見ない（呼び出し側が先に見る） */
  const agentFailure = (message: AgentMessage): string => {
    // queue に渡して届かなかった分（#838。`typed` の失敗）も、送り元に返す
    for (const turn of [run.snapshot()[message.to], typed.snapshot()[message.to]]) {
      if (turn?.failed && isDeliveryOf(turn.text, message.message_id)) return message.far ? AGENT_FAR_FAILED : replyFailureText(turn.failed)
    }
    // 預かりの先頭のまま止まった（前の返信が失敗した・起動できなかった）
    const paused = queue.paused(message.to)
    if (paused && isDeliveryOf(queue.peek(message.to)?.text, message.message_id)) return message.far ? AGENT_FAR_FAILED : paused
    return ''
  }
  /**
   * 状態が決まったメッセージ（#823）。返答ありと、生きていない（相手の預かりにも回っているターンにも無い）まま `AGENT_GONE_SETTLE_MS`
   * 返答の来なかったものを覚え、次からは行を舐めない（古いものから忘れる）
   */
  const agentSettled = new Map<string, 'done' | 'failed'>()
  /** 生きていないのに返答がまだ見えないメッセージ → 最初にそう見えた時刻。`AGENT_GONE_MS` 続いたら失敗に決める（返答の行の遅れを待つ） */
  const agentGone = new Map<string, number>()
  /**
   * 送ったメッセージの状態（#311 / #823）。返答 → 失敗・止まった（`agentFailure()`）→ 生きている（相手の預かりに並んでいるか、相手がその
   * メッセージのターンを回している）なら返答待ち → 生きていないまま `AGENT_GONE_MS` 返答が来なければ失敗（あとで返答が来れば返答ありに戻す）。**失敗の印（`FAILED_TTL_MS`）が
   * 消えたあとも返答待ちに戻さない**（一覧の「返答待ち N」がいつまでも残る。#825 のレビュー）。返答の本文は引かず、行は全部のメッセージで
   * 1 回だけ、まだ決まっていないものの一番古い送った時刻の日から読む（3 秒のポーリングで 90 日ぶんを読まない）。**詳細の枠と一覧の数が同じこれを通す**
   */
  const agentStatuses = async (messages: readonly AgentMessage[]): Promise<Map<string, AgentActivityMessage['status']>> => {
    const out = new Map<string, AgentActivityMessage['status']>()
    const open = messages.filter((m) => !agentSettled.has(m.message_id))
    const oldest = Math.min(...open.map((m) => Date.parse(m.since)).map((ms) => (Number.isFinite(ms) ? ms : 0)))
    const days = Math.min(QUEUE_DAYS, Math.max(1, Math.ceil((Date.now() - oldest) / 86_400_000) + 1))
    const repliedNow = answeredIds(open, open.length > 0 ? await rowsNow(days) : [])
    const turns: ReplyingMap = { ...typed.snapshot(), ...run.snapshot(), ...codexApp.replying(), ...opencodeApp.replying() }
    const nowMs = loopNow()
    for (const m of messages) {
      const settled = agentSettled.get(m.message_id)
      if (settled) {
        out.set(m.message_id, settled)
        continue
      }
      if (repliedNow.has(m.message_id)) {
        agentSettled.set(m.message_id, 'done')
        agentGone.delete(m.message_id)
        out.set(m.message_id, 'done')
        continue
      }
      if (agentFailure(m)) {
        out.set(m.message_id, 'failed')
        continue
      }
      const turn = turns[m.to]
      const live = queue.origins(m.to).includes(m.message_id) || (turn !== undefined && !turn.failed && isDeliveryOf(turn.text, m.message_id))
      if (live) {
        agentGone.delete(m.message_id)
        out.set(m.message_id, 'pending')
        continue
      }
      // 生きていないと見えても、端末に打ち込んだメッセージは後の文に上書きされて見失うことがある（#825 のレビュー）。
      // 失敗に見せても、返答が来れば返答ありに戻す（`AGENT_GONE_SETTLE_MS` までは行を舐め直す。過ぎたら失敗に決めて舐めない）
      const first = agentGone.get(m.message_id) ?? nowMs
      if (nowMs - first >= AGENT_GONE_SETTLE_MS) {
        agentSettled.set(m.message_id, 'failed')
        agentGone.delete(m.message_id)
      } else {
        agentGone.set(m.message_id, first)
      }
      out.set(m.message_id, nowMs - first >= AGENT_GONE_MS ? 'failed' : 'pending')
    }
    for (const id of agentSettled.keys()) {
      if (agentSettled.size <= AGENT_MESSAGES_KEEP * 2) break
      agentSettled.delete(id)
    }
    for (const id of agentGone.keys()) if (!agents.get(id)) agentGone.delete(id)
    return out
  }
  /**
   * 送り元ごとの、まだ終わっていない数（#823。サイドバーの「返答待ち N」）。数え方は枠と同じ `agentWaitCount()`。
   * 見るのは各送り元の直近の分（枠に並べるのと同じ `sentBy()` の数）と預かりだけ
   */
  const agentWaitingOf = async (): Promise<AgentWaitingMap> => {
    const froms = agents.senders()
    const recent = new Map(froms.map((from) => [from, agents.sentBy(from)] as const))
    const statuses = await agentStatuses([...recent.values()].flat())
    const out: AgentWaitingMap = {}
    for (const from of froms) {
      const count = agentWaitCount({ recent: (recent.get(from) ?? []).map((m) => ({ status: statuses.get(m.message_id) ?? 'pending' })), held: agents.heldBy(from) })
      if (agentWaitShown(count)) out[from] = count
    }
    return out
  }
  /**
   * 返答待ちの相手がいま何をしているか（#823。語は `WHY_LABEL`）。`sai_sessions` の「空きでない理由」と同じ判定のうち、
   * 回っているターン・端末・待ち・預かりだけを見る（git・PR は見ない）。どれでもなければ空
   */
  const agentOccupied = (s: SessionSummary, active: boolean, queued: ReplyQueueMap): HoldingWhy | '' =>
    agentBusy(s.id) ? 'busy' : active ? 'terminal' : s.waiting ? 'waiting' : (queued[s.id]?.items.length ?? 0) > 0 ? 'queued' : ''

  /**
   * GET /api/agent/wait?from=&message_id=&wait=1。**送った本人だけ**が待てる。wait なら最大 WAIT_MS までサーバ側で待ち、
   * まだなら 202（MCP サーバが繰り返す。エージェントに何度もツールを呼ばせない。#311）
   */
  const agentWait = async (req: IncomingMessage, res: ServerResponse, q: URLSearchParams) => {
    const refusal = agentRefusal(req)
    if (refusal) return error(res, 403, refusal)
    const message = agents.get(q.get('message_id') ?? '')
    if (!message || message.from !== q.get('from')) return error(res, 404, 'そのメッセージは見つかりません（送った本人だけが待てます。SAI を立て直すと見失います）')
    const until = Date.now() + (q.get('wait') === '1' ? WAIT_MS : 0)
    for (;;) {
      // いま sai_wait で待っている（返答はこの応答で渡るので、入力の口からは足さない。#607 のレビュー）
      waitedAt.set(message.message_id, Date.now())
      const result = await agentResult(message)
      // sai_wait で受け取ったものは送り元の会話に入った（#594）。次のターンの頭に重ねて足さない
      if (result) {
        agents.handed([message.message_id])
        return json(res, result)
      }
      if (Date.now() >= until) return json(res, { message_id: message.message_id, to: message.to, status: 'pending' } satisfies AgentWaitResponse, 202)
      await new Promise((r) => setTimeout(r, AGENT_POLL_MS))
    }
  }

  /**
   * そのセッション（送り元）から別のセッションへのメッセージのようす（#311）。送ったことが無く止めてもいなければ undefined。
   * 往復数と読み直させた量は**いま回しているターン**のもの（回していなければ 0）。直近の送り先は状態も付ける
   */
  const agentActivityOf = async (id: string, sessions: SessionSummary[]): Promise<AgentActivity | undefined> => {
    if (!agents.hasActivity(id)) return undefined
    const current = run.snapshot()[id]
    const turn = current && !current.failed && run.running(id) ? current.since : ''
    const sent = agents.sentBy(id)
    const statuses = await agentStatuses(sent)
    const queued = queue.snapshot()
    const recent = await Promise.all(
      sent.map(async (m): Promise<AgentActivityMessage> => {
        const status = statuses.get(m.message_id) ?? 'pending'
        const target = sessions.find((s) => s.id === m.to)
        // 返答待ちの相手の状態（#823）。この画面を開いているときだけ引く。別のリポジトリの相手には細かい語を出さない（#747）
        const why = status === 'pending' && target && !m.far ? agentOccupied(target, Boolean((await progress.read(target)).active), queued) : ''
        return { message_id: m.message_id, to: m.to, to_name: target ? sessionLabel(target) : m.to, since: m.since, status, ...(why ? { to_why: why } : {}), ...(m.far ? { far: true as const } : {}) }
      }),
    )
    const held: AgentHeldMessage[] = agents.heldBy(id).map((h) => {
      const target = sessions.find((s) => s.id === h.to)
      return { message_id: h.message_id, to: h.to, to_name: target ? sessionLabel(target) : h.to, at: h.at, ...(h.halted ? { halted: h.halted } : {}) }
    })
    return {
      stopped: agents.isStopped(id),
      sent: turn ? agents.sentInTurn(id, turn) : 0,
      limit: AGENT_SEND_MAX,
      read_tokens: turn ? agents.readInTurn(id, turn) : 0,
      read_budget: AGENT_TURN_READ_BUDGET,
      recent,
      ...(held.length > 0 ? { held } : {}),
    }
  }

  /**
   * `POST /api/sessions/<id>/agent/stop` と `.../agent/resume`（#311）。人が画面から、そのセッションが別のセッションへ送るのを
   * 止める・再開する。同一オリジンのみ。止めたら、そのセッションから送られて預かりに並んでいる分も取り消す
   * （相手でもう回っているターンは止めない。動いている CLI を殺すと、相手の会話が途中で切れる）
   */
  const agentStop = async (req: IncomingMessage, res: ServerResponse, id: string, stop: boolean) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let cancelled = 0
    if (stop) {
      agents.stop(id)
      cancelled = queue.removeWhere((_to, item) => item.origin !== undefined && agents.get(item.origin)?.from === id)
      // まだ送っていない預かり（#727）も捨てる。依頼の残りはここで止まる
      cancelled += agents.dropHeldBy(id)
      await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} 人がメッセージの送信を止めた（預かりから ${cancelled} 件取り消した）\n`).catch(() => {})
    } else {
      agents.resume(id)
    }
    const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
    const idle: AgentActivity = { stopped: false, sent: 0, limit: AGENT_SEND_MAX, read_tokens: 0, read_budget: AGENT_TURN_READ_BUDGET, recent: [] }
    const payload: AgentStopResponse = { id, agent: (await agentActivityOf(id, sessions)) ?? idle, cancelled }
    return json(res, payload)
  }

  return { agentRefusal, agentFrom, holdingsOf, startAskRefusal, messageCompactOf, agentSessions, agentSend, drainBacklog, scheduleBacklog, pendingRepliesOf, afterOf, agentResult, agentWaitingOf, agentWait, agentActivityOf, agentStop }
}
