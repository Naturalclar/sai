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
  private sends = new Map<string, { turn: string; count: number; read: number }>()
  /** メッセージで起動したターンを回しているセッション → そのメッセージの id */
  private origins = new Map<string, string>()
  /** 人が画面で「送信を止める」を押したセッション（送り元）。「再開する」を押すまで送らせない（#311） */
  private stopped = new Set<string>()
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
    const r = raw as Partial<Record<'messages' | 'sends' | 'origins' | 'stopped', unknown>>
    if (Array.isArray(r.messages)) {
      for (const m of r.messages) if (isMessage(m)) this.messages.set(m.message_id, m)
    }
    if (r.sends && typeof r.sends === 'object') {
      for (const [from, v] of Object.entries(r.sends as Record<string, unknown>)) {
        const t = v as { turn?: unknown; count?: unknown; read?: unknown }
        if (typeof t?.turn === 'string' && typeof t.count === 'number' && typeof t.read === 'number') this.sends.set(from, { turn: t.turn, count: t.count, read: t.read })
      }
    }
    if (r.origins && typeof r.origins === 'object') {
      for (const [entity, id] of Object.entries(r.origins as Record<string, unknown>)) if (typeof id === 'string') this.origins.set(entity, id)
    }
    if (Array.isArray(r.stopped)) for (const from of r.stopped) if (typeof from === 'string') this.stopped.add(from)
  }

  /** いまの状態を書く。tmp → rename（`replying.json` と同じ）。書けなくても送る口は止めない */
  private persist(): void {
    if (!this.statePath) return
    // 古い記録から捨てる（Map は入れた順なので、先頭が古い）
    while (this.messages.size > AGENT_MESSAGES_KEEP) this.messages.delete(this.messages.keys().next().value!)
    try {
      mkdirSync(dirname(this.statePath), { recursive: true })
      const tmp = `${this.statePath}.${process.pid}.tmp`
      const body = { messages: [...this.messages.values()], sends: Object.fromEntries(this.sends), origins: Object.fromEntries(this.origins), stopped: [...this.stopped] }
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
   * 送れた（相手のターンを起動した・預けた）ので記録し、そのターンの回数を 1 増やす。
   * `read` はその相手が読み直す量（分からなければ 0）で、ターンの合計に足す
   */
  record(message: AgentMessage, turn: string, read = 0): void {
    this.messages.set(message.message_id, message)
    const count = this.sentInTurn(message.from, turn)
    const total = this.readInTurn(message.from, turn)
    this.sends.set(message.from, { turn, count: count + 1, read: total + read })
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

  /** そのセッションが送った記録（新しい順、最大 n 件）。送った順に覚えているので、同じ時刻でも順が崩れない */
  sentBy(from: string, n: number = AGENT_RECENT): AgentMessage[] {
    return [...this.messages.values()].filter((m) => m.from === from).reverse().slice(0, n)
  }

  /** 画面に出すか（一度でも送ったか、止めている） */
  hasActivity(from: string): boolean {
    return this.stopped.has(from) || [...this.messages.values()].some((m) => m.from === from)
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

function isMessage(m: unknown): m is AgentMessage {
  if (!m || typeof m !== 'object') return false
  const r = m as Record<string, unknown>
  return ['message_id', 'from', 'to', 'text', 'since'].every((k) => typeof r[k] === 'string') && (r.handed_at === undefined || typeof r.handed_at === 'string')
}
