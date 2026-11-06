// dots との会話の受信箱（#872）。`~/.agent-feed/dots-inbox.jsonl` に 1 行ずつ足すだけ。
//
// - **書くのは SAI のサーバと受信箱のアダプター（#873。`server/dots/adapter.ts`）だけ**。サーバは人が画面で書いた投稿、
//   アダプターは dots の返答と依頼の状態。どちらも 1 行ずつ足すだけ（書き直さない）
// - 行の記録（`record.py` の `YYYY-MM-DD.jsonl`）とは混ぜない。名前が日付の形ではないので `feedFiles()` にも拾われない
// - セッションの本文・cwd・ファイルは入れない。外へ配るのはアダプターで、購読された会話の人の投稿だけ
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dotsConversations, parseDotsLine } from '../../shared/dots.ts'
import type { DotsConversation, DotsLine, DotsMessage, DotsState, DotsStateChange } from '../../shared/dots.ts'

export const DOTS_INBOX_FILE = 'dots-inbox.jsonl'

export class DotsInbox {
  readonly path: string
  private readonly now: () => Date
  private readonly newId: () => string
  /** 書き込みを 1 本ずつ流す（同時の POST で行が混ざらないように） */
  private writing: Promise<unknown> = Promise.resolve()

  constructor(path: string, opts: { now?: () => Date; newId?: () => string } = {}) {
    this.path = path
    this.now = opts.now ?? (() => new Date())
    this.newId = opts.newId ?? randomUUID
  }

  /** 読めた行だけ（壊れた行・知らない形は飛ばす）。無ければ空 */
  async lines(): Promise<DotsLine[]> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf-8')
    } catch {
      return []
    }
    const out: DotsLine[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const l = parseDotsLine(JSON.parse(line))
        if (l) out.push(l)
      } catch {
        // 壊れた行は飛ばす
      }
    }
    return out
  }

  /** 変わったかの目印（大きさと更新時刻）。無ければ `none` */
  async rev(): Promise<string> {
    try {
      const s = await stat(this.path)
      return `${s.size}:${s.mtimeMs}`
    } catch {
      return 'none'
    }
  }

  async conversations(): Promise<DotsConversation[]> {
    return dotsConversations(await this.lines())
  }

  private append(line: DotsLine): Promise<void> {
    const next = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, JSON.stringify(line) + '\n', { encoding: 'utf-8', mode: 0o600 })
    })
    this.writing = next.catch(() => {})
    return next
  }

  /** 会話があるか（人の投稿が 1 つでもあるもの） */
  async hasConversation(id: string): Promise<boolean> {
    return (await this.lines()).some((l) => l.type === 'message' && l.source === 'sai-human' && l.conversation_id === id)
  }

  /** 人の投稿を足す。`conversationId` が無ければ新しい会話。状態は書かない（行が無ければ `queued`） */
  async post(text: string, conversationId?: string): Promise<DotsMessage> {
    const message: DotsMessage = {
      type: 'message',
      id: this.newId(),
      conversation_id: conversationId ?? this.newId(),
      request_id: this.newId(),
      source: 'sai-human',
      at: this.now().toISOString(),
      text,
    }
    await this.append(message)
    return message
  }

  /** dots の返答を足す（アダプター #873 の `inbox_reply`） */
  async reply(conversationId: string, replyTo: string, text: string): Promise<DotsMessage> {
    const message: DotsMessage = { type: 'message', id: this.newId(), conversation_id: conversationId, reply_to: replyTo, source: 'dots', at: this.now().toISOString(), text }
    await this.append(message)
    return message
  }

  /** 依頼の状態を足す（アダプター #873）。進めない遷移も書くが、読むときに捨てる */
  async setState(requestId: string, state: DotsState, reason?: string): Promise<DotsStateChange> {
    const change: DotsStateChange = { type: 'state', request_id: requestId, state, at: this.now().toISOString(), ...(reason ? { reason } : {}) }
    await this.append(change)
    return change
  }
}
