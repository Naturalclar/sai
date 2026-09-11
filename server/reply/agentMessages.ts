// セッション同士のメッセージの状態（#310 / #311）。エージェント用の口のトークン、送った記録、
// 1 ターンに送った回数、メッセージで回っているターン（連鎖を 1 段で止める）を持つ。
// 最初の PR はメモリだけ。サーバを立て直すと、待っている sai_wait は「見失った」になる（相手のターンは預かりごと続く）
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { AGENT_SEND_MAX } from '../../shared/agentMessages.ts'

/** エージェント用の口（/api/agent/*）のトークンを置くファイル（feed dir の中。0600） */
export const AGENT_TOKEN_FILE = 'agent-token'
/** トークンを載せるヘッダ（Node の req.headers は小文字） */
export const AGENT_TOKEN_HEADER = 'x-sai-agent-token'

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
  }

  get(messageId: string): AgentMessage | undefined {
    return this.messages.get(messageId)
  }

  /**
   * そのセッションのターンを起動した。メッセージで起動したならその id を覚え、人の返信で起動したなら忘れる
   * （次にそのセッションが送ろうとしたとき、連鎖かどうかをこれで見る）
   */
  launched(entity: string, messageId: string | undefined): void {
    if (messageId) this.origins.set(entity, messageId)
    else this.origins.delete(entity)
  }

  /** そのセッションがいまメッセージで起動したターンを回しているなら、その id */
  origin(entity: string): string | undefined {
    return this.origins.get(entity)
  }
}
