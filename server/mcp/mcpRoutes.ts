// tailnet から MCP で呼ぶ口（#312）の区分。`createApp()`（app.ts）から外に出したもの（#809）。JSON-RPC は `protocol.ts`、
// 誰に何を許すかは `access.ts`、回数の枠は `sendLimit.ts`。ここは道具の中身（`mcpTools`）と HTTP の口（`mcpHttp`）。
//
// `createMcpRoutes(ctx)` は関数を作って返すだけ。回数の枠（`mcpLimiter`）は起動時にファイルを読むので、`createApp()` が今までの位置で作って渡す。
// 身元の確かめ（whois）は入口のまま。capability と `Origin` の検査は `mcpHttp()` の中で、順番は変えていない
import { appendFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  AGENT_TEXT_MAX_CHARS,
  AGENT_TURN_READ_BUDGET,
  agentEntry,
  ASSIGN_NOTE,
  budgetRefusal,
  clipReply,
  deliveredFromTailnet,
  idleNote,
  resolveTarget,
  SEND_COMPACT_ARG,
  SEND_COMPACT_NOTE,
  SEND_TERMINAL_NOTE,
  SEND_TO_ARG,
  sendHow,
  sessionLabel,
  splitHandedReplies,
  targetRefusal,
  tokensLabel,
  usageRefusal,
} from '../../shared/agentMessages.ts'
import { startsNewWork } from '../../shared/compact.ts'
import { entityId } from '../../shared/entity.ts'
import { eventKind } from '../../shared/events.ts'
import { FREE_NOTE, holdingLabel, START_ASK_NOTE } from '../../shared/holding.ts'
import { isRemoteHost } from '../../shared/host.ts'
import { modeName, modeSkipsRules, replyModeOf } from '../../shared/permissions.ts'
import { stepLabel } from '../../shared/progress.ts'
import { replyBlockedReason } from '../../shared/reply.ts'
import type { ReplyError, ReplyResponse, SessionHolding, SessionSummary } from '../../shared/types.ts'
import { AGENT_POLL_MS, QUEUE_DAYS } from '../appContext.ts'
import type { AppContext } from '../appContext.ts'
import type { Identity } from '../auth.ts'
import { selfHost } from '../host.ts'
import { mcpAccess, normalizeOrigin } from './access.ts'
import type { McpAccess } from './access.ts'
import { handleRpc, protocolVersionOk, textResult } from './protocol.ts'
import type { McpTool } from './protocol.ts'
import type { McpSendLimiter } from './sendLimit.ts'

/** 回数の枠は持ち主の `createApp()` が作ったものを足して渡す */
export function createMcpRoutes(ctx: AppContext & { mcpLimiter: McpSendLimiter }) {
  const { store, typed, run, queue, agents, progress, codexApp, opencodeApp, settingsStore, suggestionStore, usageStore, seenContext, mcpLimiter, loopNow } = ctx
  const { launch, sessionsWithMeta, rowsNow, settleWaiting, approvalsNow, holdingsOf, startAskRefusal, agentResult, messageCompactOf, readJson, selfUrl } = ctx

  /** sai_sessions が見る日数 */
  const MCP_LIST_DAYS = 7
  /**
   * sai_wait がサーバ側で待つ既定と上限（秒）。Serve を通る 1 本の HTTP を長く握らないように短めにし、
   * まだならエージェントにもう一度呼ばせる（stdio の sai_wait は最長 30 分繰り返すが、HTTP は間に Serve がいる）
   */
  const MCP_WAIT_DEFAULT_S = 60
  const MCP_WAIT_MAX_S = 120
  const MAX_MCP_BYTES = 256 * 1024
  /** tailnet の MCP から来たメッセージの送り元（sai_wait で本人を確かめる鍵）。セッションの id と混ざらない形 */
  const mcpFrom = (access: McpAccess) => `mcp:${access.caller}`
  const mcpBusy = (id: string) => run.running(id) || codexApp.running(id) || opencodeApp.running(id) || typed.running(id)
  const mcpStr = (v: unknown) => (typeof v === 'string' ? v : '')
  /**
   * `/mcp` から見た「いま持っているもの」（#727 / #795）。**`sai_sessions` の印も、`sai_send` の送る時点の確かめも、ここを通す**。
   * 待ちは画面と同じもの（#323。Manager が本文を読まずに急ぐものを選ぶ）: 端末で人が答えたぶんは畳み（#255）、返信中の答え待ち
   * （承認のバブル）も足す。待ち・答え待ち・預かり・処理中（端末で人が回しているターンも）のどれかがあれば空きではない。
   * 送れない相手（別のマシン・素通し・合成 ID など）には「空き」も理由も付けない
   */
  const mcpHoldingsOf = async (list: SessionSummary[], only?: string) => {
    const { sessions } = await settleWaiting(list)
    const pending = await approvalsNow(sessions)
    const byDefault = (await settingsStore.get()).reply_mode
    const queued = queue.snapshot()
    const here = sessions.filter((s) => !isRemoteHost(s.host, selfHost()))
    const read = new Map(await Promise.all(here.map(async (s) => [s.id, await progress.read(s)] as const)))
    const active = new Map([...read].map(([id, p]) => [id, p.active] as const))
    const holdings = await holdingsOf(
      sessions,
      (s) => (mcpBusy(s.id) ? 'busy' : active.get(s.id) ? 'terminal' : s.waiting || (pending[s.id]?.length ?? 0) > 0 ? 'waiting' : (queued[s.id]?.items.length ?? 0) > 0 ? 'queued' : ''),
      (s) => !mcpSendRefusal(s, byDefault),
      only === undefined ? {} : { only },
    )
    return { sessions, pending, byDefault, read, active, holdings }
  }
  /** 一覧の 1 行に出す分。待ちの中身を別に出す行では、理由の「（待ち）」を重ねない */
  const mcpHoldingShown = (h: SessionHolding | undefined, waitingShown: boolean): SessionHolding => {
    if (!h) return {}
    if (!waitingShown || h.why !== 'waiting') return h
    const { why: _dropped, ...rest } = h
    return rest
  }
  const mcpNum = (v: unknown, fallback: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback)

  /**
   * tailnet から送れない相手なら理由。アーカイブ済み・返信できない（別のマシン・合成 ID など）に加えて、
   * **ルールに関係なく通るモード（bypassPermissions / auto）を選んだセッションには送らない**（tailnet の呼び出し元の LLM が、許可を聞かないエージェントを動かせてしまう。#253 / #691）
   */
  const mcpSendRefusal = (s: SessionSummary, byDefault: string): string => {
    if (s.archived) return 'アーカイブ済み'
    const blocked = replyBlockedReason(s, selfHost())
    if (blocked) return blocked
    // 設定の既定が素通しなら、メタに何も無いセッションも素通しで回る（#582）。既定が付くのは Claude だけ
    // （`--permission-mode` を渡す先が無い Codex / OpenCode まで断らない）
    const mode = replyModeOf(s.meta?.permission_mode, s.agent === 'claude' ? byDefault : '')
    if (modeSkipsRules(mode)) return `許可を聞かないモード（${modeName(mode)}）のセッションには tailnet から送れません`
    return ''
  }

  /**
   * `/mcp` の宛先を引く（#625）。**id がそのまま当たればそれ**（送れない・置けない理由は呼び出し側が今までどおり返す）。
   * 当たらなければ、`allowed` を通るセッションの中から呼び名の完全一致で探し、ちょうど 1 つのときだけ返す。決まらなければ断りの文
   */
  const mcpTarget = (sessions: SessionSummary[], asked: string, allowed: (s: SessionSummary) => boolean): SessionSummary | string => {
    const byId = sessions.find((s) => s.id === asked)
    if (byId) return byId
    // 送れない・置けないが居るセッション（素通し・別のマシンなど）に同じ名前があれば、名前では当てない（別の相手に黙って届かせない）
    const resolved = resolveTarget(sessions.filter(allowed), asked, sessions.filter((s) => !s.archived && !allowed(s)))
    if (resolved.target) return resolved.target
    // 候補は当たりが複数のときだけ並べる（tailnet からは全リポジトリが見えるので、無いときに全部は並べない）
    return resolved.ambiguous ? targetRefusal(asked, resolved, '') : 'そのセッションは見つかりません（sai_sessions で確かめてください）'
  }

  /**
   * MCP のツール。読むもの（read）は画面・REST と同じ範囲。案を置く（draft。#565）は入力欄に置くだけでターンを起こさない。
   * 送る・待つ（send）はエージェント用の口（#310）と同じ規則
   * （見出しで人の入力と見分ける・相手が処理中なら預かり・返答は見出しの id で探して切る・受け取ったターンからは先へ送らせない）
   */
  const mcpTools = (req: IncomingMessage, access: McpAccess): McpTool[] => [
    {
      name: 'sai_sessions',
      scope: 'read',
      description: `SAI に並んでいるセッションの一覧（直近 ${MCP_LIST_DAYS} 日、アーカイブ済みを除く）。id・呼び名・リポジトリ・エージェント・ブランチ・処理中か・**いま持っているもの**（空いているか（${FREE_NOTE}）・ブランチから出ている open な PR と CI・ブランチ名や PR の題名・届いている依頼から引けた issue の番号・頼まれてまだ返していない依頼の数。機械で引けたものだけで、無ければ出ない）・待ち（許可・質問）・送れない理由・読み直す量と最後のターンからの時間（このマシンのセッションだけ。時間は処理中・待ちのセッションには出ない。「キャッシュ切れの見込み」と付いた相手は、送ると文脈をほぼ全部書き直す）・最後の記録の時刻・最後の発言の 1 行目`,
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'リポジトリ（owner/repo）で絞る' } } },
      run: async (args) => {
        const project = mcpStr(args.project)
        const { sessions: all } = await sessionsWithMeta(MCP_LIST_DAYS)
        const list = all.filter((s) => !s.archived && (!project || s.project === project))
        if (list.length === 0) return textResult('セッションはありません')
        const { sessions, pending, byDefault, read, active, holdings } = await mcpHoldingsOf(list)
        // 呼んだ人が見た量を覚える（#795。着手の依頼を送る時点で、ここから大きく増えていたら送らない）
        seenContext.set(mcpFrom(access), new Map([...read].map(([id, p]) => [id, p.context_tokens])))
        return textResult(
          sessions
            .map((s) => {
              const why = mcpSendRefusal(s, byDefault)
              const waiting = clipReply((s.waiting || pending[s.id]?.[0]?.text || '').split('\n')[0] ?? '', 120)
              // 読み直す量と間（#761）。割り振る側が、小さくて温かい相手を選べるように。間は、このマシンの、回っても待ってもいないセッションにだけ
              const e = agentEntry(s, mcpBusy(s.id), read.get(s.id)?.context_tokens ?? 0, undefined, read.has(s.id) && !active.get(s.id) && !waiting ? loopNow() : undefined)
              return `- ${e.id}「${e.name}」${e.project} ${e.agent}${e.branch ? ` ${e.branch}` : ''}${e.busy ? '（処理中）' : ''}${holdingLabel(mcpHoldingShown(holdings.get(s.id), waiting !== ''))}${waiting ? `（待ち: ${waiting}）` : ''}${why ? `（送れない: ${why}）` : ''}${s.manager_draft ? '（案を置いてある）' : ''}${e.context_tokens ? ` 読み直す量: ${tokensLabel(e.context_tokens)}` : ''}${idleNote(e.idle_ms, e.agent)} 最後の記録: ${s.end}${e.last_text ? ` 最後の発言: ${e.last_text}` : ''}`
            })
            .join('\n'),
        )
      },
    },
    {
      name: 'sai_session',
      scope: 'read',
      description: 'セッションの直近のやりとり（人の入力とエージェントの返答）。長いものは切る',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'sai_sessions の id' }, turns: { type: 'number', description: '何ターンぶん（既定 3、最大 10）' } },
        required: ['id'],
      },
      run: async (args) => {
        const id = mcpStr(args.id)
        const turns = (await rowsNow(QUEUE_DAYS)).filter((r) => eventKind(r.event, r.text) === 'turn' && entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id)
        if (turns.length === 0) return textResult('そのセッションのターンは見つかりません（sai_sessions の id を渡してください）', true)
        return textResult(
          turns
            .slice(-mcpNum(args.turns, 3, 1, 10))
            .map((r) => `## ${r.ts}\n${splitHandedReplies(r.user_text ?? '').text ? `人: ${clipReply(splitHandedReplies(r.user_text ?? '').text, 500)}\n` : ''}エージェント: ${clipReply(r.text ?? '', 2000)}`)
            .join('\n\n'),
        )
      },
    },
    {
      name: 'sai_progress',
      scope: 'read',
      description: '処理中のセッションが、いま何をしているか（走っているツール・直近の手順）',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'sai_sessions の id' } }, required: ['id'] },
      run: async (args) => {
        const { sessions } = await store.sessions(QUEUE_DAYS)
        const session = sessions.find((s) => s.id === mcpStr(args.id))
        if (!session) return textResult('そのセッションは見つかりません', true)
        if (isRemoteHost(session.host, selfHost())) return textResult('別のマシンのセッションの手順は読めません', true)
        const p = await progress.read(session)
        if (p.steps.length === 0) return textResult('いまの手順はありません（処理中でないか、読めるファイルがありません）')
        return textResult([p.active ? '処理中:' : '動いていません（最後のターンの手順）:', ...p.steps.map((s) => `- ${stepLabel(s)}${s.kind === 'tool' && !s.ended ? '（実行中）' : ''}`)].join('\n'))
      },
    },
    {
      name: 'sai_suggest',
      scope: 'draft',
      description: `宛先のセッションの入力欄に「案」を置く（送らない・ターンを起こさない）。人が画面で見て、入れて送るか捨てるかを決める。1 セッションに 1 つで、置き直すと前の案は消える。24 時間か、人がそのセッションに何か送ると消える。本文は ${AGENT_TEXT_MAX_CHARS} 字まで`,
      inputSchema: { type: 'object', properties: { to: { type: 'string', description: SEND_TO_ARG }, text: { type: 'string', description: '入力欄に置く本文（そのまま送れる形で）' } }, required: ['to', 'text'] },
      run: async (args) => {
        const asked = mcpStr(args.to)
        const text = mcpStr(args.text).trim()
        if (!asked || !text) return textResult('to と text が要ります', true)
        if (text.length > AGENT_TEXT_MAX_CHARS) return textResult(`置けるのは ${AGENT_TEXT_MAX_CHARS} 字までです。短くまとめてください`, true)
        const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
        // 宛先は id か呼び名（#625）。名前で引くのは、案を置ける相手（アーカイブ済みでない・画面に入力欄が出る）の中からだけ
        const found = mcpTarget(sessions, asked, (s) => !s.archived && !replyBlockedReason(s, selfHost()))
        if (typeof found === 'string') return textResult(found, true)
        const target = found
        const to = target.id
        // 別のリポジトリ・素通しのセッションにも置ける（送るのは人なので）。画面に入力欄が出ないものにだけは置かない
        if (target.archived) return textResult('置けません: アーカイブ済み', true)
        const blocked = replyBlockedReason(target, selfHost())
        if (blocked) return textResult(`置けません: ${blocked}`, true)
        // 回っているターンがあれば覚えておく（そのターンの終わりは人の入力ではないので、そこでは消さない）
        const busy = mcpBusy(to) || (await progress.read(target)).active
        await suggestionStore.put(to, text, access.caller, { busy })
        await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${mcpFrom(access)} → ${to} 案を置いた（${text.length} 字）\n`).catch(() => {})
        return textResult(`${to}「${sessionLabel(target)}」の入力欄に案を置きました（送ってはいません。人が SAI の画面で見て、入れて送るか捨てるかを決めます）`)
      },
    },
    {
      name: 'sai_send',
      scope: 'send',
      description: `別のセッションに頼む・聞く。相手が処理中なら終わってから回る。${SEND_TERMINAL_NOTE}。${START_ASK_NOTE}。返答は sai_wait で受け取る。本文は ${AGENT_TEXT_MAX_CHARS} 字まで。${SEND_COMPACT_NOTE}。${ASSIGN_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string', description: SEND_TO_ARG }, text: { type: 'string' }, compact: { type: 'boolean', description: SEND_COMPACT_ARG } },
        required: ['to', 'text'],
      },
      run: async (args) => {
        const asked = mcpStr(args.to)
        const text = mcpStr(args.text).trim()
        if (!asked || !text) return textResult('to と text が要ります', true)
        if (text.length > AGENT_TEXT_MAX_CHARS) return textResult(`送れるのは ${AGENT_TEXT_MAX_CHARS} 字までです。短くまとめてください`, true)
        const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
        // 宛先は id か呼び名（#625）。名前で引くのは送れる相手の中からだけ（id なら、送れない理由をそのまま返す）
        const byDefault = (await settingsStore.get()).reply_mode
        const found = mcpTarget(sessions, asked, (s) => !mcpSendRefusal(s, byDefault))
        if (typeof found === 'string') return textResult(found, true)
        const target = found
        const to = target.id
        const why = mcpSendRefusal(target, byDefault)
        if (why) return textResult(`送れません: ${why}`, true)
        const limit = mcpLimiter.refusal(access.caller)
        if (limit) return textResult(limit, true)
        // 相手のエージェントの使用量の枠と、相手に読み直させる量の予算（#311 と同じ規則）。
        // tailnet から呼ぶ側には SAI が起動したターンが無いので、予算は呼んだ人ごとに回数と同じ区切り（10 分）で数える
        const overUsage = usageRefusal(await usageStore.get(), target.agent)
        if (overUsage) return textResult(overUsage, true)
        const context = (await progress.read(target)).context_tokens
        const window = mcpLimiter.windowKey()
        const overBudget = budgetRefusal(agents.readInTurn(mcpFrom(access), window), context)
        if (overBudget) return textResult(overBudget, true)
        // 着手の形の依頼は、送る時点で相手が空きでなければ送らない（#795。一覧と同じ `mcpHoldingsOf()`）。
        // 待ちの走査は宛先を引いた窓で回す（一覧の窓より広い。一覧の窓の外に居る相手を、引き直しても直らない「状態不明」で断らない）。
        // git・`claude agents`・マージ済みの PR を読むのは宛先の 1 件だけ
        if (startsNewWork(text)) {
          const { holdings } = await mcpHoldingsOf(sessions.filter((s) => !s.archived), to)
          const no = startAskRefusal(holdings.get(to), context, seenContext.get(mcpFrom(access))?.get(to) ?? 0, false)
          if (no) return textResult(no, true)
        }
        const messageId = agents.newId()
        const compact = messageCompactOf(target, text, context, args.compact)
        const out = await launch(to, deliveredFromTailnet(access.caller, messageId, text), [], { days: QUEUE_DAYS, replaceTyped: false, forceProcess: false, url: selfUrl(req), queue: true, origin: messageId, terminalFallback: true, ...compact })
        if (out.status !== 202) return textResult(`送れませんでした: ${(out.body as ReplyError).error}`, true)
        const { via, stuck } = out.body as ReplyResponse
        mcpLimiter.record(access.caller)
        agents.record({ message_id: messageId, from: mcpFrom(access), to, text, since: new Date().toISOString() }, window, context)
        await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${mcpFrom(access)} → ${to} メッセージ ${messageId}（${via}）\n`).catch(() => {})
        const size = tokensLabel(context)
        return textResult(
          `${to}「${sessionLabel(target)}」に送りました（message_id: ${messageId}。${sendHow(via, stuck === true)}）。` +
            `${size ? `${via === 'compact' ? '要約の前の相手の文脈は' : '相手が読み直す量は'}${size}（予算の残り ${tokensLabel(Math.max(0, AGENT_TURN_READ_BUDGET - agents.readInTurn(mcpFrom(access), window))) || '0'}）。` : ''}返答は sai_wait で受け取れます`,
        )
      },
    },
    {
      name: 'sai_wait',
      scope: 'send',
      description: `sai_send で送ったメッセージへの返答を待って受け取る（最大 ${MCP_WAIT_MAX_S} 秒。まだならもう一度呼ぶ）`,
      inputSchema: {
        type: 'object',
        properties: { message_id: { type: 'string' }, wait_seconds: { type: 'number', description: `待つ秒数（既定 ${MCP_WAIT_DEFAULT_S}、最大 ${MCP_WAIT_MAX_S}）` } },
        required: ['message_id'],
      },
      run: async (args) => {
        const message = agents.get(mcpStr(args.message_id))
        if (!message || message.from !== mcpFrom(access)) return textResult('そのメッセージは見つかりません（送った本人だけが待てます。SAI を立て直すと見失います）', true)
        const until = Date.now() + mcpNum(args.wait_seconds, MCP_WAIT_DEFAULT_S, 0, MCP_WAIT_MAX_S) * 1000
        for (;;) {
          const result = await agentResult(message)
          if (result) agents.handed([message.message_id])
          if (result?.status === 'done') return textResult(result.text ?? '')
          if (result?.status === 'failed') return textResult(`相手のターンが失敗しました: ${result.error ?? ''}`, true)
          if (Date.now() >= until) return textResult('まだ返答がありません。あとでもう一度 sai_wait を呼んでください')
          await new Promise((r) => setTimeout(r, AGENT_POLL_MS))
        }
      },
    },
  ]

  /**
   * `/mcp`（Streamable HTTP の最小。#312）。POST で 1 通受けて JSON で 1 回返す（SSE・セッションは出さない）。
   * - 使えるツールは身元と tailnet の ACL の capability で決める（`server/mcp/access.ts`）。何も使えなければ 403
   * - **Origin は必ず検査する**（MCP の仕様。DNS rebinding）: 無ければ（CLI・サーバ間）通し、あれば capability の origins に書いたものだけ。CORS もそれにだけ返す
   * - 同一オリジンの検査（`isCrossOrigin()`）は使わない。CLI は Origin を付けないので歯止めにならず、代わりが capability
   */
  const mcpHttp = async (req: IncomingMessage, res: ServerResponse, who: Identity, method: string) => {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const text = body === undefined ? '' : JSON.stringify(body)
      res.writeHead(status, { ...(text ? { 'Content-Type': 'application/json' } : {}), 'Cache-Control': 'no-store', ...headers })
      res.end(text)
    }
    const access = mcpAccess(who)
    if (access.scopes.size === 0) return respond(403, { error: 'MCP を使う許可がありません（タグ付きの端末は、tailnet の ACL の grants で capability を与えてください）' })
    const originHeader = req.headers.origin
    const origin = typeof originHeader === 'string' ? normalizeOrigin(originHeader) : ''
    if (originHeader !== undefined && (!origin || !access.origins.has(origin))) {
      return respond(403, { error: 'この Origin からは呼べません（tailnet の ACL の grants で origins に書いたページだけ）' })
    }
    const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}
    if (method === 'OPTIONS') {
      return respond(204, undefined, {
        ...cors,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id',
        'Access-Control-Max-Age': '600',
      })
    }
    if (method !== 'POST') return respond(405, { error: 'POST だけです（SSE の GET とセッションの DELETE は出していません）' }, { ...cors, Allow: 'POST, OPTIONS' })
    if (!protocolVersionOk(req.headers['mcp-protocol-version'])) return respond(400, { error: 'MCP-Protocol-Version が対応していない版です' }, cors)
    let message: unknown
    try {
      message = await readJson(req, MAX_MCP_BYTES)
    } catch (err) {
      return respond(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: err instanceof Error ? err.message : 'parse error' } }, cors)
    }
    if (Array.isArray(message)) return respond(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'バッチは受けません' } }, cors)
    const response = await handleRpc(message, mcpTools(req, access), access.scopes)
    return response ? respond(200, response, cors) : respond(202, undefined, cors)
  }

  return { mcpBusy, mcpHttp }
}
