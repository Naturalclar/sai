// セッション同士のメッセージの状態（#310 / #311）。エージェント用の口のトークン、送った記録、
// 1 ターンに送った回数、メッセージで回っているターン（連鎖を 1 段で止める）を持つ。
// **サーバを立て直しても残す**（#440）: `statePath`（`~/.agent-feed/agent-messages.json`）に書き、起動時に読む。
// 前はメモリだけで、立て直すと待っている sai_wait が「見失った」になり、「送信を止める」が外れ、1 ターンの回数と予算が 0 から数え直しになった
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { AGENT_SEND_MAX } from '../../shared/agentMessages.ts'

/** エージェント用の口（/api/agent/*）のトークンを置くファイル（feed dir の中。0600） */
export const AGENT_TOKEN_FILE = 'agent-token'
/** トークンを載せるヘッダ（Node の req.headers は小文字） */
export const AGENT_TOKEN_HEADER = 'x-sai-agent-token'
/** 画面に出す直近の送り先の数（#311） */
export const AGENT_RECENT = 5
/** 送った状態を残すファイル（feed dir の中。#440） */
export const AGENT_MESSAGES_FILE = 'agent-messages.json'
/** 残す送った記録の数（古いものから捨てる。`sai_wait` が探すのは最近のものだけで、画面は直近 `AGENT_RECENT` 件） */
export const AGENT_MESSAGES_KEEP = 500
/** 覚えておく「返答のバブルの下から人が送った返信」（#700）の数。古いものから捨てる */
export const AGENT_FOLLOWUPS_KEEP = 200
/** 覚える本文の上限（返答を探すのに頭を比べるだけ。画面には頭しか出さない） */
const FOLLOWUP_TEXT_CHARS = 500

/** 立て直しの前に送りかけていた預かりに付ける理由（#727） */
export const HALTED_ON_RESTART = '送っている途中でサーバが立て直されました。届いたか分からないので、送り直していません'

/**
 * 1 ターンの回数（か読み直しの予算）を超えたので預かった送信（#727）。送り元のターンが終わってから、サーバが順に送る。
 * `message_id` は預かるときに決める（エージェントに返してあり、送るときの見出しにもそのまま入る）
 */
export interface HeldSend {
  message_id: string
  from: string
  to: string
  /** エージェントが書いた本文（見出しを付ける前） */
  text: string
  /** 預かったときの送り元のターン（`Replying.since`）。依頼の単位 */
  turn: string
  /** 預かった時刻 */
  at: string
  /** 預かったときに数えた、相手が読み直す量（分からなければ 0） */
  context: number
  /** 送るときに使うサーバの URL（預かったときのリクエストのもの） */
  url: string
  wake?: true
  /** エージェントが渡した `compact`（省略なら送るときに判定する） */
  compact?: boolean
  /** 別のリポジトリの相手（#747）。量・失敗の理由・題名を送り元のエージェントに出さない */
  far?: true
  /** 送りかけの印（送る直前に書く）。付いたまま立て直されたら送り直さない */
  sending?: string
  /** 止まった理由。付いているものは自動では送らない（人が「送信を止める」で捨てる） */
  halted?: string
}

/**
 * 人が送り元（`from`）の画面の、相手（`to`）の返答のバブルの下から送った返信（#700）。メッセージ（`sai_send`）ではない:
 * 送り元のターンは起こさず、返答を送り元の会話にも渡さない。送り元の画面に出すためだけに覚える
 */
export interface AgentFollowup {
  id: string
  from: string
  to: string
  text: string
  at: string
  /** どのバブルの下か（その返答の行の `ts`）。表示にしか使わない */
  anchor: string
}

/** 送った記録 1 件 */
export interface AgentMessage {
  message_id: string
  /** 送り元のエンティティID */
  from: string
  /** 送り先のエンティティID */
  to: string
  /** エージェントが書いた本文（見出しを付ける前） */
  text: string
  /** 送った時刻 */
  since: string
  /**
   * 返答（か失敗）を送り元の会話に渡した時刻（#594）。次のターンの頭に足したか、`sai_wait` で受け取ったとき。
   * 付いていれば 2 回は足さない（立て直しても残る）
   */
  handed_at?: string
  /** 返答が来たら送り元を起こす（#594 の 3。`sai_send` の `wake`） */
  wake?: true
  /** 送ったときの送り元のターン（`Replying.since`）。同じターンで `wake` を付けたものをまとめて 1 回だけ起こす */
  turn?: string
  /** 起こすときに使う、このサーバ自身の宛先（許可・質問を画面で答える MCP の宛先。`selfUrl()`） */
  url?: string
  /**
   * 送ったときに別のリポジトリの相手だった（#747）。**送ったときに決めて覚える**（あとで組を外しても、行の `project` の埋まり方が
   * 変わっても、返答の見出し・失敗の理由・読み直す量を送り元のエージェントに出さない）
   */
  far?: true
}

/**
 * トークンを読む。無い・形が違えばその場で作って 0600 で書く。
 * ブラウザ（同一オリジンの画面も tailnet 経由も）はこのファイルを読めないので、エージェント用の口を叩けない。
 * 書けなくてもサーバは止めない（メモリのトークンで動き、MCP サーバが読めないので sai_* が使えないだけ）
 */
export function ensureAgentToken(path: string): string {
  try {
    const current = readFileSync(path, 'utf-8').trim()
    if (/^[0-9a-f]{64}$/.test(current)) return current
  } catch {
    // 無ければ作る
  }
  const token = randomBytes(32).toString('hex')
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, token + '\n', { mode: 0o600 })
    chmodSync(path, 0o600)
  } catch {
    // 書けなくても口は閉じたまま（誰もトークンを知らない）
  }
  return token
}

/** トークンが合うか。長さが違えば比べない（timingSafeEqual は長さ違いで投げる） */
export function tokenMatches(expected: string, got: unknown): boolean {
  if (!expected || typeof got !== 'string' || got.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected))
}

export class AgentMessages {
  private messages = new Map<string, AgentMessage>()
  /** 送り元 → そのターン（`Replying.since`）と、そのターンで送った回数・相手に読み直させた量 */
  private sends = new Map<string, { turn: string; count: number; read: number; hidden?: number }>()
  /** メッセージで起動したターンを回しているセッション → そのメッセージの id */
  private origins = new Map<string, string>()
  /** 人が画面で「送信を止める」を押したセッション（送り元）。「再開する」を押すまで送らせない（#311） */
  private stopped = new Set<string>()
  /** 人が返答のバブルの下から送った返信（#700。古い順） */
  private followups: AgentFollowup[] = []
  /** 1 ターンの回数を超えて預かった送信（#727。古い順）。送り元のターンが終わってから順に送る */
  private backlog: HeldSend[] = []
  /** 送った・止めた・再開したで進める（詳細の rev に混ぜる） */
  private version = 0
  private readonly statePath: string

  /** `statePath` を渡せば、前のサーバが残した状態を読み、以後の変化を書く（#440）。渡さなければメモリだけ（テスト） */
  constructor(statePath = '') {
    this.statePath = statePath
    this.load()
  }

  /** 前のサーバが残したものを読む。壊れていれば無かったことにする（送る口は閉じない） */
  private load(): void {
    if (!this.statePath) return
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.statePath, 'utf-8'))
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object') return
    const r = raw as Partial<Record<'messages' | 'sends' | 'origins' | 'stopped' | 'followups' | 'backlog', unknown>>
    if (Array.isArray(r.messages)) {
      for (const m of r.messages) if (isMessage(m)) this.messages.set(m.message_id, m)
    }
    if (r.sends && typeof r.sends === 'object') {
      for (const [from, v] of Object.entries(r.sends as Record<string, unknown>)) {
        const t = v as { turn?: unknown; count?: unknown; read?: unknown }
        if (typeof t?.turn === 'string' && typeof t.count === 'number' && typeof t.read === 'number') this.sends.set(from, { turn: t.turn, count: t.count, read: t.read, ...(typeof (t as { hidden?: unknown }).hidden === 'number' ? { hidden: (t as { hidden: number }).hidden } : {}) })
      }
    }
    if (r.origins && typeof r.origins === 'object') {
      for (const [entity, id] of Object.entries(r.origins as Record<string, unknown>)) if (typeof id === 'string') this.origins.set(entity, id)
    }
    if (Array.isArray(r.stopped)) for (const from of r.stopped) if (typeof from === 'string') this.stopped.add(from)
    if (Array.isArray(r.followups)) for (const f of r.followups) if (isFollowup(f)) this.followups.push(f)
    // 預かり（#727）。**送りかけの印が付いたまま残っているものは、前のサーバが送っている途中で落ちた分**。届いたかどうか
    // 分からないので送り直さず（二重に送らない）、止まった理由を付けて残す（忘れない。人が画面で見て、止めるか頼み直す）
    if (Array.isArray(r.backlog)) {
      for (const h of r.backlog) {
        if (!isHeld(h) || this.messages.has(h.message_id)) continue
        this.backlog.push(h.sending && !h.halted ? { ...h, halted: HALTED_ON_RESTART } : h)
      }
    }
  }

  /** いまの状態を書く。tmp → rename（`replying.json` と同じ）。書けなくても送る口は止めない */
  private persist(): void {
    if (!this.statePath) return
    // 古い記録から捨てる（Map は入れた順なので、先頭が古い）
    while (this.messages.size > AGENT_MESSAGES_KEEP) this.messages.delete(this.messages.keys().next().value!)
    try {
      mkdirSync(dirname(this.statePath), { recursive: true })
      const tmp = `${this.statePath}.${process.pid}.tmp`
      const body = { messages: [...this.messages.values()], sends: Object.fromEntries(this.sends), origins: Object.fromEntries(this.origins), stopped: [...this.stopped], followups: this.followups, backlog: this.backlog }
      writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.statePath)
    } catch {
      // 書けなくてもメモリで続く（立て直すと消えるだけ。#440 より前と同じ）
    }
  }

  /** 見出しに入れるので、送る前に作る */
  newId(): string {
    return randomBytes(8).toString('hex')
  }

  /** 送り元のこのターンで、もう何回送ったか。ターンが変われば 0 */
  sentInTurn(from: string, turn: string): number {
    const s = this.sends.get(from)
    return s && s.turn === turn ? s.count : 0
  }

  /**
   * 送れないなら理由（#311）。送れるなら空。
   * - メッセージで回っているターンからは送れない（A → B → C と伝言が続かないように、連鎖は 1 段まで）
   * - 1 ターンに `max` 回まで
   */
  refusal(from: string, turn: string, max: number = AGENT_SEND_MAX): string {
    if (this.stopped.has(from)) return '人がこのセッションからの送信を止めています。続けるなら人に確かめてください'
    if (this.origins.has(from)) return '別のセッションから受け取ったメッセージで回っているターンからは送れません（連鎖は 1 段まで）'
    if (this.sentInTurn(from, turn) >= max) return `このターンで送れるのは ${max} 回までです。続けるなら人に確かめてください`
    return ''
  }

  /** 送り元のこのターンで、相手に読み直させた量の合計（#311）。ターンが変われば 0 */
  readInTurn(from: string, turn: string): number {
    const s = this.sends.get(from)
    return s && s.turn === turn ? s.read : 0
  }

  /**
   * そのターンの合計のうち、**エージェントには見せない分**（#747。別のリポジトリの相手が読み直す量）。予算には数えるが、
   * 送信の応答・断りの文には出さない（合計から引き算して、一覧で伏せた相手の量が分かってしまうため）
   */
  hiddenInTurn(from: string, turn: string): number {
    const s = this.sends.get(from)
    return s && s.turn === turn ? (s.hidden ?? 0) : 0
  }

  /**
   * 送れた（相手のターンを起動した・預けた）ので記録し、そのターンの回数を 1 増やす。
   * `read` はその相手が読み直す量（分からなければ 0）で、ターンの合計に足す。別のリポジトリの相手（`message.far`）なら、その量は見せない分にも足す（#747）
   */
  record(message: AgentMessage, turn: string, read = 0): void {
    this.messages.set(message.message_id, message)
    const count = this.sentInTurn(message.from, turn)
    const total = this.readInTurn(message.from, turn)
    const kept = this.hiddenInTurn(message.from, turn) + (message.far ? read : 0)
    this.sends.set(message.from, { turn, count: count + 1, read: total + read, ...(kept > 0 ? { hidden: kept } : {}) })
    this.version++
    this.persist()
  }

  /**
   * 預かっていた分を送れたので記録する（#727）。**1 ターンの回数・量（`sends`）には足さない**: 送るのは送り元のターンの外で、
   * 足すと送り元がいま回している別のターンの数を上書きしてしまう（1 巡の上限は送る側が自分で数える）
   */
  recordHeld(message: AgentMessage): void {
    this.messages.set(message.message_id, message)
    this.version++
    this.persist()
  }

  /** 人が送信を止めた（#311）。もう止まっていれば false */
  stop(from: string): boolean {
    if (this.stopped.has(from)) return false
    this.stopped.add(from)
    this.version++
    this.persist()
    return true
  }

  /** 人が再開した。止まっていなければ false */
  resume(from: string): boolean {
    if (!this.stopped.delete(from)) return false
    this.version++
    this.persist()
    return true
  }

  isStopped(from: string): boolean {
    return this.stopped.has(from)
  }

  /** そのセッションに届けた記録（古い順。#727）。`since` が `notBefore` より前のものは除く */
  sentTo(to: string, notBefore: number): AgentMessage[] {
    return [...this.messages.values()].filter((m) => m.to === to && Date.parse(m.since) >= notBefore)
  }

  /** そのセッション宛ての、まだ送っていない預かり（古い順。止まっているものは除く。#727） */
  heldFor(to: string): HeldSend[] {
    return this.backlog.filter((h) => h.to === to && !h.halted)
  }

  /** そのセッションが送った記録（新しい順、最大 n 件）。送った順に覚えているので、同じ時刻でも順が崩れない */
  sentBy(from: string, n: number = AGENT_RECENT): AgentMessage[] {
    return [...this.messages.values()].filter((m) => m.from === from).reverse().slice(0, n)
  }

  /**
   * 人が `from` の画面の返答のバブルの下から `to` へ返信した（#700）。**`from` が `to` にメッセージを送ったことがあるときだけ**覚える
   * （返答のバブルが出うる組だけ。それ以外は画面に出す場所が無い）。覚えたら true
   */
  follow(from: string, to: string, text: string, anchor: string, at: string = new Date().toISOString()): boolean {
    if (from === to || ![...this.messages.values()].some((m) => m.from === from && m.to === to)) return false
    this.followups.push({ id: this.newId(), from, to, text: text.slice(0, FOLLOWUP_TEXT_CHARS), at, anchor })
    if (this.followups.length > AGENT_FOLLOWUPS_KEEP) this.followups.splice(0, this.followups.length - AGENT_FOLLOWUPS_KEEP)
    this.version++
    this.persist()
    return true
  }

  // ---- 預かった送信（#727）

  /** 預かる。送る順は預かった順 */
  hold(item: HeldSend): void {
    this.backlog.push(item)
    this.version++
    this.persist()
  }

  /** その送り元の預かり（古い順）。止まっているもの（`halted`）も含む */
  heldBy(from: string): HeldSend[] {
    return this.backlog.filter((h) => h.from === from)
  }

  /** 預かりのある送り元 */
  heldFroms(): string[] {
    return [...new Set(this.backlog.map((h) => h.from))]
  }

  /** その依頼（送り元のそのターン）で預かっている数と、読み直させる量の合計。`hidden` はそのうちエージェントに見せない分（#747） */
  heldInTurn(from: string, turn: string): { count: number; read: number; hidden: number } {
    const list = this.backlog.filter((h) => h.from === from && h.turn === turn)
    return { count: list.length, read: list.reduce((sum, h) => sum + h.context, 0), hidden: list.reduce((sum, h) => sum + (h.far ? h.context : 0), 0) }
  }

  /**
   * これから送る印を付けて書く（**送る前に書く**。送っている途中でサーバが落ちても、立て直したあとに同じものをもう一度送らない）。
   * もう無い・止まっている・送りかけなら false
   */
  beginHeld(messageId: string, at: string = new Date().toISOString()): boolean {
    const i = this.backlog.findIndex((h) => h.message_id === messageId)
    const h = this.backlog[i]
    if (!h || h.halted || h.sending) return false
    this.backlog[i] = { ...h, sending: at }
    this.persist()
    return true
  }

  /** 止める（自動では送らない）。理由を付けて残す。もう無ければ false */
  haltHeld(messageId: string, reason: string): boolean {
    const i = this.backlog.findIndex((h) => h.message_id === messageId)
    const h = this.backlog[i]
    if (!h) return false
    this.backlog[i] = { ...h, halted: reason }
    this.version++
    this.persist()
    return true
  }

  /** 預かりから外す（送れた・人が止めた）。外したら true */
  dropHeld(messageId: string): boolean {
    const before = this.backlog.length
    this.backlog = this.backlog.filter((h) => h.message_id !== messageId)
    if (this.backlog.length === before) return false
    this.version++
    this.persist()
    return true
  }

  /** その送り元の預かりを全部捨てる（人が「送信を止める」を押した）。捨てた数 */
  dropHeldBy(from: string): number {
    const before = this.backlog.length
    this.backlog = this.backlog.filter((h) => h.from !== from)
    const dropped = before - this.backlog.length
    if (dropped > 0) {
      this.version++
      this.persist()
    }
    return dropped
  }

  /** `from` の画面から送った返信（古い順） */
  followupsBy(from: string): AgentFollowup[] {
    return this.followups.filter((f) => f.from === from)
  }

  /** 画面に出すか（一度でも送ったか、止めている） */
  hasActivity(from: string): boolean {
    return this.stopped.has(from) || this.backlog.some((h) => h.from === from) || [...this.messages.values()].some((m) => m.from === from)
  }

  /** rev に混ぜる。送った・止めた・再開したで変わる */
  key(): string {
    return String(this.version)
  }

  /**
   * 返答を送り元の会話に渡した（#594）。もう渡してあるものは触らない（最初に渡した時刻を残す）
   */
  handed(messageIds: readonly string[], at: string = new Date().toISOString()): void {
    let changed = false
    for (const id of messageIds) {
      const m = this.messages.get(id)
      if (!m || m.handed_at) continue
      this.messages.set(id, { ...m, handed_at: at })
      changed = true
    }
    if (!changed) return
    this.version++
    this.persist()
  }

  /**
   * 「返答が来たら起こす」で送って、まだ渡していないものを、送り元とターンごとにまとめる（#594 の 3）。`since` が `notBefore` より前は除く
   */
  wakeGroups(notBefore: number): AgentMessage[][] {
    const groups = new Map<string, AgentMessage[]>()
    for (const m of this.messages.values()) {
      if (!m.wake || m.handed_at || Date.parse(m.since) < notBefore) continue
      const key = `${m.from}\0${m.turn ?? ''}`
      const list = groups.get(key)
      if (list) list.push(m)
      else groups.set(key, [m])
    }
    return [...groups.values()]
  }

  /** 「渡した」を取り消す（#594。返答を頭に足したターンが失敗して、エージェントが読んでいないとき） */
  unhand(messageIds: readonly string[]): void {
    let changed = false
    for (const id of messageIds) {
      const m = this.messages.get(id)
      if (!m?.handed_at) continue
      const { handed_at: _dropped, ...rest } = m
      this.messages.set(id, rest)
      changed = true
    }
    if (!changed) return
    this.version++
    this.persist()
  }

  /** そのセッションが送って、まだ返答を渡していない記録（古い順）。`since` がこれより前のものは除く */
  unhanded(from: string, notBefore: number): AgentMessage[] {
    return [...this.messages.values()].filter((m) => m.from === from && !m.handed_at && Date.parse(m.since) >= notBefore)
  }

  get(messageId: string): AgentMessage | undefined {
    return this.messages.get(messageId)
  }

  /**
   * そのセッションのターンを起動した。メッセージで起動したならその id を覚え、人の返信で起動したなら忘れる
   * （次にそのセッションが送ろうとしたとき、連鎖かどうかをこれで見る）
   */
  launched(entity: string, messageId: string | undefined): void {
    const before = this.origins.get(entity)
    if (messageId) this.origins.set(entity, messageId)
    else this.origins.delete(entity)
    if (before !== messageId) this.persist()
  }

  /** そのセッションがいまメッセージで起動したターンを回しているなら、その id */
  origin(entity: string): string | undefined {
    return this.origins.get(entity)
  }
}

function isHeld(h: unknown): h is HeldSend {
  if (!h || typeof h !== 'object') return false
  const v = h as Record<string, unknown>
  return ['message_id', 'from', 'to', 'text', 'turn', 'at', 'url'].every((k) => typeof v[k] === 'string') && typeof v.context === 'number'
}

function isFollowup(f: unknown): f is AgentFollowup {
  if (!f || typeof f !== 'object') return false
  const v = f as Record<string, unknown>
  return ['id', 'from', 'to', 'text', 'at', 'anchor'].every((k) => typeof v[k] === 'string')
}

/** 送った記録の形か。壊れた 1 件は読まない（記録を調べる道具も同じこの検査で読む。#703） */
export function isMessage(m: unknown): m is AgentMessage {
  if (!m || typeof m !== 'object') return false
  const r = m as Record<string, unknown>
  return ['message_id', 'from', 'to', 'text', 'since'].every((k) => typeof r[k] === 'string') && (r.handed_at === undefined || typeof r.handed_at === 'string')
}
