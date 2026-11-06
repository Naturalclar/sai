// 受信箱のアダプター（#873）が覚えておくもの: 購読と、配信の進み具合。`~/.agent-feed/dots-adapter.json` に置く（`0600`）。
// 立て直しても購読と再送の途中が戻るように、変えるたびに書き直す（一時ファイルから rename）。
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DOTS_ADAPTER_FILE = 'dots-adapter.json'

/** 署名の鍵。替えたあとも、前の鍵は `until` まで一緒に署名する（受け手が切り替える間） */
export interface SubscriptionSecret {
  secret: string
  /** ISO。無ければ今の鍵 */
  until?: string
}

export interface Subscription {
  /** 決まった値（`subscriptionId()`）。同じ購読を何度作っても同じ id */
  id: string
  name: 'message.created'
  conversation_id: string
  url: string
  secrets: SubscriptionSecret[]
  /** 購読したトークンの持ち主。配信の前に、まだ許されているかを見る */
  subject: string
  /** 作った時刻 */
  created_at: string
  /** 作ったときに会話にあった投稿の id。これは配らない（時刻は同じミリ秒で並ぶことがあるので、時刻では比べない） */
  before: string[]
  /** 期限。過ぎたら配らずに消す（呼び直されると延びる） */
  expires_at: string
}

export interface Delivery {
  subscription: string
  /** 受信箱の投稿の id（= `eventId`。送り直しても同じ） */
  message_id: string
  request_id: string
  conversation_id: string
  attempts: number
  /** ISO。次に送ってよい時刻 */
  next_at: string
  status: 'pending' | 'delivered' | 'failed'
  delivered_at?: string
  /** 最後に返ってきた HTTP の状態（届かなければ 0） */
  last_status?: number
  reason?: string
}

interface Saved {
  subscriptions: Subscription[]
  deliveries: Delivery[]
}

/** 同じ持ち主・同じイベント・同じ会話・同じ送り先なら同じ id */
export function subscriptionId(subject: string, name: string, conversationId: string, url: string): string {
  return `sub_${createHash('sha256').update(JSON.stringify([subject, name, conversationId, url])).digest('hex').slice(0, 32)}`
}

export const deliveryKey = (subscription: string, messageId: string) => `${subscription}:${messageId}`

export class AdapterState {
  readonly path: string
  private subs = new Map<string, Subscription>()
  private deliveries = new Map<string, Delivery>()
  private loading: Promise<void> | null = null
  private writing: Promise<unknown> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  /** 読み終わるまで、同時に呼ばれても同じ 1 回を待たせる（読み終える前に書いたものを、古い中身で被せない） */
  load(): Promise<void> {
    this.loading ??= this.read()
    return this.loading
  }

  private async read(): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.path, 'utf-8'))
    } catch {
      return
    }
    const r = raw as Partial<Saved>
    for (const s of Array.isArray(r.subscriptions) ? r.subscriptions : []) if (s && typeof s.id === 'string') this.subs.set(s.id, { ...s, before: Array.isArray(s.before) ? s.before : [], secrets: Array.isArray(s.secrets) ? s.secrets : [] })
    for (const d of Array.isArray(r.deliveries) ? r.deliveries : []) if (d && typeof d.subscription === 'string' && typeof d.message_id === 'string') this.deliveries.set(deliveryKey(d.subscription, d.message_id), d)
  }

  subscriptions(): Subscription[] {
    return [...this.subs.values()]
  }

  subscription(id: string): Subscription | undefined {
    return this.subs.get(id)
  }

  delivery(subscription: string, messageId: string): Delivery | undefined {
    return this.deliveries.get(deliveryKey(subscription, messageId))
  }

  allDeliveries(): Delivery[] {
    return [...this.deliveries.values()]
  }

  async putSubscription(s: Subscription): Promise<void> {
    this.subs.set(s.id, s)
    await this.save()
  }

  /** 消す。無くても何もしない（2 回目も同じ結果）。その購読の配信の途中も捨てる */
  async removeSubscription(id: string): Promise<boolean> {
    const had = this.subs.delete(id)
    let dropped = false
    for (const [k, d] of this.deliveries) {
      if (d.subscription === id && d.status === 'pending') {
        this.deliveries.delete(k)
        dropped = true
      }
    }
    if (had || dropped) await this.save()
    return had
  }

  async putDelivery(d: Delivery): Promise<void> {
    this.deliveries.set(deliveryKey(d.subscription, d.message_id), d)
    await this.save()
  }

  /** 終わった配信の記録を捨てる（古いものを溜めない） */
  async removeDeliveryRecord(d: Delivery): Promise<void> {
    if (this.deliveries.delete(deliveryKey(d.subscription, d.message_id))) await this.save()
  }

  private save(): Promise<void> {
    const body = JSON.stringify({ subscriptions: [...this.subs.values()], deliveries: [...this.deliveries.values()] } satisfies Saved)
    const next = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      await writeFile(tmp, body, { encoding: 'utf-8', mode: 0o600 })
      await chmod(tmp, 0o600)
      await rename(tmp, this.path)
    })
    this.writing = next.catch(() => {})
    return next
  }
}
