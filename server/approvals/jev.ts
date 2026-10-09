// 許可のバブルに、許可して問題なさそうかを Jev で予想した確率を添える（#491）。何を聞くか・何を送るかは shared/jev.ts。
//
// **ここが SAI から外（TypeSafe AI）へ許可の中身を送る場所**。「SAI は外に出さない」の例外で、次の 3 つで縛る:
// - 鍵（JEV_API_KEY）が無ければ何も送らない（`jevFromEnv()` が null を返す）。鍵は環境変数のままで画面からは変えさせない
// - 入切できる（settings.json の `jev`。既定は入）。切れば送らない
// - 送り先は固定。**リダイレクトは追わない**（追うと Authorization を付けたまま別の場所へ送る。jev の CLI と同じ）
//
// 画面の 3 秒のポーリングを待たせない: 聞いていない許可を見つけたら投げるだけで、答えは届いたときに覚え、次の応答に載せる。
// **同じ許可（approval_id）には 1 回だけ**聞く（失敗も覚えて聞き直さない。口が落ちているときに叩き続けない）。
import { JEV_RULE_STATEMENT, JEV_SAFE_STATEMENT, jevAsks, jevSafeOf, jevState } from '../../shared/jev.ts'
import type { Approval, ApprovalMap } from '../../shared/types.ts'

/** 許可の状態の文（と、どの主張を確かめるか。省略は JEV_SAFE_STATEMENT）を渡すと、その主張が本当らしい確率（0..1）を返す。聞けなければ投げる */
export type JevJudge = (state: string, statement?: string) => Promise<number>

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'
/** 1 回を諦めるまで（実測で 1 回 1〜2 秒） */
export const JEV_TIMEOUT_MS = 20_000
/** 答えを覚えておく長さ（**最後に見かけてから**。許可が消えてからも、しばらく同じ id が来れば聞き直さない） */
export const JEV_KEEP_MS = 30 * 60_000
/** 同時に投げる上限（許可が一度にたくさん出ても、まとめて叩かない） */
export const JEV_CONCURRENCY = 2

const QUESTION = 'safe'

/** 鍵があれば本物の口。無ければ null（**何も送らない**） */
export function jevFromEnv(env: NodeJS.ProcessEnv = process.env, doFetch: typeof fetch = fetch): JevJudge | null {
  const key = env.JEV_API_KEY?.trim()
  if (!key) return null
  return async (state, statement = JEV_SAFE_STATEMENT) => {
    const res = await doFetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state, model: JEV_MODEL, questions: { [QUESTION]: { type: 'noul', instructions: statement } } }),
      // 鍵を付けたまま別の場所へ送らない
      redirect: 'error',
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`Jev が HTTP ${res.status} を返しました`)
    const safe = jevSafeOf(await res.json(), QUESTION)
    if (safe === null) throw new Error('Jev の応答に確率がありませんでした')
    return safe
  }
}

interface Entry {
  /** 届いた確率。失敗・まだなら undefined */
  safe?: number
  failed?: boolean
  at: number
}

export class JevRisk {
  private readonly judge: JevJudge | null
  private readonly now: () => number
  private readonly entries = new Map<string, Entry>()
  private readonly waiting: { id: string; state: string; statement: string }[] = []
  /** 答えが届く（失敗も）たびに呼ぶ。自動の「常に許可」（#499）がここで動く。画面のポーリングに依らない */
  onArrive: (() => void) | null = null
  private running = 0
  private version = 0
  /** 失敗の理由（最後の 1 つ）。reply.log などに残す人向け */
  lastError = ''

  constructor(judge: JevJudge | null, now: () => number = Date.now) {
    this.judge = judge
    this.now = now
  }

  /** 送れるか（鍵があるか） */
  get ready(): boolean {
    return this.judge !== null
  }

  /**
   * 許可に確率を添えた写しを返す（元のオブジェクトは触らない。承認の預かりが持っている本物を書き換えない）。
   * `enabled` が false なら聞かず、覚えている確率も付けない。聞いていないものは投げるだけで、今回は付かない
   */
  annotate(map: ApprovalMap, enabled: boolean): ApprovalMap {
    if (!enabled || !this.judge) {
      this.prune()
      return map
    }
    const out: ApprovalMap = {}
    for (const [id, list] of Object.entries(map)) {
      out[id] = list.map((approval) => {
        if (!jevAsks(approval)) return approval
        const entry = this.entries.get(approval.approval_id)
        if (!entry) {
          this.ask(approval)
          return approval
        }
        // 見かけるたびに時刻を進める（忘れるのは「見なくなってから」30 分。長く待っている許可を聞き直さない。#493 のレビュー）
        entry.at = this.now()
        return entry.safe === undefined ? approval : { ...approval, jev: entry.safe }
      })
    }
    // 忘れるのは、いま出ている許可の時刻を進めたあと（#750 のレビュー）。先に忘れると、30 分以上だれも見なかった許可
    // （タブを閉じていた）の確率を捨てて聞き直し、届く前に人が答えると記録に確率が残らない
    this.prune()
    return out
  }

  /**
   * その許可に聞いた控えを見るだけ（#749。記録に残すため）。**聞かない・時刻も進めない**（答えたあとに呼ぶので、覚えを延ばさない）。
   * 聞いていなければ undefined、聞いて届いていなければ `safe` も `failed` も無い
   */
  peek(approvalId: string): { safe?: number; failed?: boolean } | undefined {
    const entry = this.entries.get(approvalId)
    return entry ? { ...(entry.safe !== undefined ? { safe: entry.safe } : {}), ...(entry.failed ? { failed: true } : {}) } : undefined
  }

  /** rev に混ぜる（答えが届いたら画面のポーリングが拾う） */
  key(): string {
    return String(this.version)
  }

  private ask(approval: Approval) {
    this.entries.set(approval.approval_id, { at: this.now() })
    this.waiting.push({ id: approval.approval_id, state: jevState(approval), statement: JEV_SAFE_STATEMENT })
    this.pump()
  }

  /**
   * ルールそのもの（`Bash(rm:*)` など）が問題なさそうな確率（#499）。ルールごとに 1 回だけ聞き、届くまでは undefined。
   * 鍵は `rule:<表記>`（許可の id とは別の空間）。`enabled` は呼び出し側が見る（切っていれば呼ばない）
   */
  ruleSafe(label: string, state: string): number | undefined {
    if (!this.judge) return undefined
    const key = `rule:${label}`
    const entry = this.entries.get(key)
    if (entry) {
      entry.at = this.now()
      return entry.safe
    }
    this.entries.set(key, { at: this.now() })
    this.waiting.push({ id: key, state, statement: JEV_RULE_STATEMENT })
    this.pump()
    return undefined
  }

  /**
   * 覚えているルールの確率を見るだけ（#553。聞かない。読む経路から外へ送らないため）。無い・まだなら undefined。
   * **見かけた時刻は進める**（`annotate()` と同じ。進めないと、ポーリングが `prune()` を回すうちに 30 分で忘れ、
   * 待っている許可のルールの印が消え、次に自動の判定が動いたときに同じルールをもう一度聞く。#556 のレビュー）
   */
  peekRule(label: string): number | undefined {
    const entry = this.entries.get(`rule:${label}`)
    if (entry) entry.at = this.now()
    return entry?.safe
  }

  /** ルールを聞いて失敗したか（#556 のレビュー。失敗は聞き直さないので、待ちのままにせず見送りの理由にする） */
  ruleFailed(label: string): boolean {
    return this.entries.get(`rule:${label}`)?.failed === true
  }

  private pump() {
    while (this.judge && this.running < JEV_CONCURRENCY && this.waiting.length > 0) {
      const next = this.waiting.shift()!
      this.running++
      const judge = this.judge
      void judge(next.state, next.statement)
        .then(
          (safe) => {
            this.entries.set(next.id, { safe, at: this.now() })
          },
          (err: unknown) => {
            this.lastError = err instanceof Error ? err.message : String(err)
            this.entries.set(next.id, { failed: true, at: this.now() })
          },
        )
        .finally(() => {
          this.running--
          this.version++
          this.pump()
          this.onArrive?.()
        })
    }
  }

  private prune() {
    const cutoff = this.now() - JEV_KEEP_MS
    for (const [id, entry] of this.entries) {
      // 投げている最中（safe も failed も無い）は消さない（届いたときに入れ直して、また聞いてしまう）
      if (entry.at < cutoff && (entry.safe !== undefined || entry.failed)) this.entries.delete(id)
    }
  }
}
