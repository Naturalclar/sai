// チャットの一言コメント（digest）。エージェントの返答（text）を、性格つきの 1〜2 文に言い換える。
//
// 作るのは LLM で、既定は返信と同じ `claude` CLI を `-p` で叩く（依存を足さない。実行ファイルはサーバの PATH の `claude`）。
// 口を openai にすると OpenAI 互換の HTTP（Ollama / LM Studio / llama.cpp / vLLM）を Node の fetch で叩く。
// 結果は ~/.agent-feed/digest.jsonl に追記し、JSONL（記録）は触らない。派生データなので消しても履歴は壊れない。
// 既定はオフ。入切・口・モデルは settings.json（画面の自分のメニュー）で、サーバを立て直さずに切り替わる（#288。前は環境変数）。
// 入でも「入にしたあと（起動時に入なら起動したあと）に増えた行」だけ作り、過去の行は作らない。
// 1 行ずつ直列で回し、失敗した行は無いまま（画面は text を出す）。
import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { entityId } from '../../shared/entity.ts'
import { eventKind } from '../../shared/events.ts'
import { digestPrompt } from '../../shared/persona.ts'
import { childEnv } from '../reply/runner.ts'
import type { DigestProvider, FeedRow, PersonaId } from '../../shared/types.ts'

export const DIGEST_FILE = 'digest.jsonl'
export const DEFAULT_DIGEST_MODEL = 'haiku'
/** 口が openai のときの既定の base URL（Ollama。LM Studio は http://127.0.0.1:1234/v1）。変えるのは SAI_DIGEST_URL だけ */
export const DEFAULT_OPENAI_URL = 'http://127.0.0.1:11434/v1'
/** 1 件あたりの上限。これを超えたら失敗扱い（次の行へ） */
export const DIGEST_TIMEOUT_MS = 90_000
/**
 * 「起動したあと」の境目を、起動時刻より少しだけ前に置く幅。
 * 行の `ts` はフックの中で `record.py` が採った時刻で、その行が JSONL に書かれるのは（トランスクリプトを読む分だけ）
 * 数百ミリ秒〜数秒あと。ちょうどその間にサーバが起動すると、起動後に届いた行なのに `ts` は起動より古い。
 * 取りこぼすより 1 件多く作る方が害が小さいので、この幅だけ遡って対象にする
 */
export const DIGEST_SINCE_SLACK_MS = 5_000

export interface DigestEntry {
  /** 行を一意に指す。`<entityId>|<ts>` */
  key: string
  persona: PersonaId
  summary: string
  model: string
  /** 作った時刻 */
  ts: string
}

/** 行のキー。行は (エンティティ, ts) で一意 */
export function digestKey(row: Pick<FeedRow, 'session' | 'repo' | 'ts'>): string {
  return `${entityId(row.session, row.repo, row.ts)}|${row.ts}`
}

/** 一言を作る対象か。ターン完了で本文がある行だけ（待ちの行・入力の行・本文なしは作らない） */
export function digestable(row: FeedRow): boolean {
  return eventKind(row.event) === 'turn' && Boolean(row.text?.trim())
}

export interface Summarizer {
  /** prompt を渡して一言を返す。空文字や失敗は throw（呼び出し側が「無いまま」にする） */
  summarize(prompt: string): Promise<string>
}

/** `claude -p` の起動引数。テストで並びを見る。実行ファイルはサーバの PATH の `claude`（#288） */
export function summarizeCommand(model: string): { bin: string; args: string[] } {
  // --bare は OAuth を読まないので使えない（Not logged in になる）。フックは AGENT_FEED_SKIP=1 で黙らせる
  return {
    bin: 'claude',
    args: ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence'],
  }
}

/** 本物。`claude -p` にプロンプトを stdin で渡し、JSON の result を取る */
export class ClaudeSummarizer implements Summarizer {
  private readonly model: string
  private readonly cwd: string
  private readonly env: NodeJS.ProcessEnv

  constructor(model: string, cwd: string, env: NodeJS.ProcessEnv = process.env) {
    this.model = model
    this.cwd = cwd
    this.env = env
  }

  summarize(prompt: string): Promise<string> {
    const { bin, args } = summarizeCommand(this.model)
    return new Promise<string>((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: this.cwd,
        // フック（record.py）に「記録するな」を伝える。この子が Stop の行として載るのを防ぐ。
        // 万一記録されても、SAI が起動した子なのでサーバのペインは継がせない（childEnv。#234）
        env: { ...childEnv(this.env), AGENT_FEED_SKIP: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`timeout after ${DIGEST_TIMEOUT_MS}ms`))
      }, DIGEST_TIMEOUT_MS)
      child.stdout.on('data', (b: Buffer) => out.push(b))
      child.stderr.on('data', (b: Buffer) => err.push(b))
      child.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        const stdout = Buffer.concat(out).toString('utf-8')
        let parsed: { is_error?: boolean; result?: unknown } | null = null
        try {
          parsed = JSON.parse(stdout) as { is_error?: boolean; result?: unknown }
        } catch {
          parsed = null
        }
        if (!parsed) return reject(new Error(`exit ${code}: ${(Buffer.concat(err).toString('utf-8') || stdout).trim().slice(0, 200)}`))
        const result = typeof parsed.result === 'string' ? parsed.result.trim() : ''
        if (parsed.is_error || !result) return reject(new Error(`claude: ${result || 'empty result'}`))
        resolve(result)
      })
      child.stdin.end(prompt)
    })
  }
}

/** `POST <base>/chat/completions` の組み立て。テストで形を見る。末尾の `/` は有っても無くてもよい */
export function summarizeRequest(baseUrl: string, model: string, prompt: string, apiKey?: string): { url: string; init: RequestInit } {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  return {
    url: `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
    },
  }
}

/** 思考つきのモデル（qwen3 など）が OpenAI 互換の口でも本文の先頭に混ぜる `<think>…</think>` を落とす。閉じていなければそこから後ろを全部落とす */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '')
    .trim()
}

/**
 * OpenAI 互換の HTTP で作る（Ollama / LM Studio / llama.cpp / vLLM）。依存は足さず Node の fetch。
 * 子プロセスを立てないので AGENT_FEED_SKIP の話は無い。`claude` が無い環境でも動く
 */
export class OpenAISummarizer implements Summarizer {
  private readonly baseUrl: string
  private readonly model: string
  private readonly apiKey: string | undefined
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(baseUrl: string, model: string, apiKey?: string, timeoutMs = DIGEST_TIMEOUT_MS, fetchFn: typeof fetch = fetch) {
    this.baseUrl = baseUrl
    this.model = model
    this.apiKey = apiKey
    this.timeoutMs = timeoutMs
    this.fetchFn = fetchFn
  }

  async summarize(prompt: string): Promise<string> {
    const { url, init } = summarizeRequest(this.baseUrl, this.model, prompt, this.apiKey)
    const res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) })
    const body = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.trim().slice(0, 200)}`)
    let parsed: { choices?: { message?: { content?: unknown } }[] }
    try {
      parsed = JSON.parse(body) as { choices?: { message?: { content?: unknown } }[] }
    } catch {
      throw new Error(`not JSON: ${body.trim().slice(0, 200)}`)
    }
    const content = parsed.choices?.[0]?.message?.content
    const text = typeof content === 'string' ? stripThinking(content) : ''
    if (!text) throw new Error('empty result')
    return text
  }
}

/** digest.jsonl。起動時に全部読み、以後は追記した分をメモリにも足す */
export class DigestStore {
  readonly path: string
  private entries = new Map<string, DigestEntry>()
  private loaded = false
  private revValue = ''

  constructor(path: string) {
    this.path = path
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      for (const line of (await readFile(this.path, 'utf-8')).split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const e = JSON.parse(t) as DigestEntry
          if (e && typeof e.key === 'string' && typeof e.summary === 'string') this.entries.set(e.key, e)
        } catch {
          // 壊れた行は落とす
        }
      }
      const st = await stat(this.path)
      this.revValue = `${st.mtimeMs}:${st.size}`
    } catch {
      // 無ければ空
    }
  }

  get(key: string): DigestEntry | undefined {
    return this.entries.get(key)
  }

  get size(): number {
    return this.entries.size
  }

  /** 中身が変わったかの識別子。rev に混ぜる */
  rev(): string {
    return this.revValue
  }

  async append(entry: DigestEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, JSON.stringify(entry) + '\n', 'utf-8')
    this.entries.set(entry.key, entry)
    this.revValue = `${Date.now()}:${this.entries.size}`
  }
}

/** 口とモデルから Summarizer を作る。`Digester.configure()` が入にしたとき・口やモデルを変えたときに呼ぶ */
export type SummarizerFactory = (provider: DigestProvider, model: string) => Summarizer

/** 一言の入切・口・モデル（settings.json のうち、作る側が見るぶん。`Settings` をそのまま渡せる） */
export interface DigestSettings {
  digest: boolean
  digest_provider: DigestProvider
  /** 空なら口の既定（claude は haiku。openai は既定が無いので作らない） */
  digest_model: string
}

export interface DigesterOptions {
  /** 最初の入切。あとから `configure()` で変わる */
  enabled: boolean
  model: string
  /** 一言を作る口。無ければ claude */
  provider?: DigestProvider
  /** 一言を作る子プロセスの cwd（フィードのディレクトリ）。ここを cwd にした行は自分の雑音なので作らない */
  ownDir?: string
  /**
   * その行の性格。作る直前に行ごとに引く（セッションのメタに persona があればそれ、無ければ全体の既定。変えたら以後の行から効く）。
   * **`null` なら作らない**（そのセッションのメタで切られている。#263）
   */
  persona: (row: FeedRow) => Promise<PersonaId | null>
  /**
   * これより古い `ts` の行は作らない（= サーバが起動した時刻。ISO）。既定は「いま」＝ Digester を作った時刻。
   * テストから固定値を渡すためにある。読めない値なら「いま」に落とす
   */
  since?: string
  /** 失敗の記録先（無ければ捨てる） */
  logPath?: string
}

export class Digester {
  readonly store: DigestStore
  private readonly make: SummarizerFactory | null
  /** いまの口。null なら作らない（切っている・組めなかった） */
  private summarizer: Summarizer | null
  private modelValue: string
  private providerValue: DigestProvider
  private errorValue = ''
  private readonly persona: (row: FeedRow) => Promise<PersonaId | null>
  private readonly logPath: string | undefined
  private readonly ownDir: string | undefined
  /**
   * この時刻より古い行は作らない（ミリ秒）。サーバが起動した時刻（あとから入にしたならその時刻）- DIGEST_SINCE_SLACK_MS。
   * 「起動時に見えていた行の集合」ではなく時刻で切るので、あとから `days` が広がって古い行が見えても積まれない（#159）
   */
  private sinceMs: number
  private queue: { key: string; row: FeedRow }[] = []
  private queued = new Set<string>()
  private pumping = false

  /**
   * `summarizer` は固定の口（テストの偽物）か、口とモデルから作る関数（本物。`createDigester()`）。null なら入にできない。
   * `opts` の enabled / model / provider は最初の状態で、`configure()` で変わる
   */
  constructor(store: DigestStore, summarizer: Summarizer | SummarizerFactory | null, opts: DigesterOptions) {
    this.store = store
    this.make = summarizer === null ? null : typeof summarizer === 'function' ? summarizer : () => summarizer
    this.modelValue = opts.model
    this.providerValue = opts.provider ?? 'claude'
    this.summarizer = opts.enabled && this.make ? this.make(this.providerValue, this.modelValue) : null
    this.persona = opts.persona
    this.logPath = opts.logPath
    this.ownDir = opts.ownDir
    const since = opts.since === undefined ? Date.now() : Date.parse(opts.since)
    this.sinceMs = (Number.isNaN(since) ? Date.now() : since) - DIGEST_SINCE_SLACK_MS
  }

  /** いま作っているか（入にしていて、口が組めた） */
  get enabled(): boolean {
    return this.summarizer !== null
  }

  /** 実際に使うモデル（空の設定なら口の既定を入れたもの） */
  get model(): string {
    return this.modelValue
  }

  get provider(): DigestProvider {
    return this.providerValue
  }

  /** 入にしたのに作れない理由。無ければ空 */
  get error(): string {
    return this.errorValue
  }

  /**
   * 入切・口・モデルを変える。起動時（settings.json）と PUT /api/settings から呼び、サーバは立て直さない（#288）。
   * - **切から入にしたら、境目を「いま」に進める**。切っていた間に届いた行はさかのぼって作らない（起動時に入にしたのと同じ扱い。
   *   さかのぼると、入にした瞬間に何日ぶんもの行が列に積まれて口を占有する）
   * - 切ったら列を捨てる（作りかけの 1 件だけは、その口で終わらせる）
   * - openai の口でモデルが空なら作らず、理由を `error` に出す（サーバは落とさない）
   */
  configure(next: DigestSettings): void {
    const was = this.enabled
    this.providerValue = next.digest_provider
    this.modelValue = next.digest_model || (next.digest_provider === 'claude' ? DEFAULT_DIGEST_MODEL : '')
    this.errorValue = ''
    this.summarizer = null
    if (next.digest) {
      if (!this.make) this.errorValue = '一言を作る口がありません'
      else if (!this.modelValue) this.errorValue = 'openai の口にはモデル名が要ります（ローカルのモデル名。例 qwen3:8b）'
      else this.summarizer = this.make(this.providerValue, this.modelValue)
    }
    if (!this.enabled) {
      for (const q of this.queue) this.queued.delete(q.key)
      this.queue = []
    } else if (!was) {
      this.sinceMs = Date.now() - DIGEST_SINCE_SLACK_MS
    }
  }

  /**
   * サーバが起動する前に記録された行か。`ts` は `+09:00`、起動時刻は `Z` と書式が違うので、
   * 文字列ではなくミリ秒で比べる。読めない `ts` は「古い」側に倒す（作らない）
   */
  private isPast(row: FeedRow): boolean {
    const ms = Date.parse(row.ts ?? '')
    return Number.isNaN(ms) || ms < this.sinceMs
  }

  /** 対象の行か。ターン完了で本文があり、自分が回した子（cwd がフィードのディレクトリ）ではない */
  private wants(row: FeedRow): boolean {
    if (!digestable(row)) return false
    const cwd = row.cwd ?? ''
    return !this.ownDir || (cwd !== this.ownDir && !cwd.startsWith(this.ownDir + '/'))
  }

  /** rev に混ぜる。一言ができるたびに変わる */
  revKey(): string {
    return this.store.rev()
  }

  /** 行に summary を載せる。無い行はそのまま（コピーしない） */
  attach(rows: FeedRow[]): FeedRow[] {
    if (this.store.size === 0) return rows
    return rows.map((r) => {
      const e = this.store.get(digestKey(r))
      return e ? { ...r, summary: e.summary } : r
    })
  }

  summaryFor(entity: string, ts: string): string | undefined {
    return ts ? this.store.get(`${entity}|${ts}`)?.summary : undefined
  }

  /**
   * いま見えている行を渡す。サーバが起動したあとの `ts` を持つ対象の行だけを、新しい順に列に積む。
   * 3 秒ごとの応答のついでに呼ばれる前提で、軽い。
   * 渡される行は呼び出し側（app.ts の scanDigest）の `days` の窓ぶんなので、窓が広がると古い行も入ってくる。
   * 基準が時刻なのでそれらは積まれない（行の集合を基準にすると、窓が広がった瞬間に過去が全部「新しい行」になる。#159）
   */
  scan(rows: FeedRow[]): void {
    if (!this.enabled) return
    const fresh: { key: string; row: FeedRow }[] = []
    for (const row of rows) {
      if (!this.wants(row) || this.isPast(row)) continue
      const key = digestKey(row)
      if (this.queued.has(key) || this.store.get(key)) continue
      fresh.push({ key, row })
    }
    if (fresh.length === 0) return
    fresh.sort((a, b) => (a.row.ts < b.row.ts ? 1 : a.row.ts > b.row.ts ? -1 : 0))
    for (const f of fresh) {
      this.queued.add(f.key)
      this.queue.push(f)
    }
    void this.pump()
  }

  /** 列の長さ（テスト用） */
  pending(): number {
    return this.queue.length + (this.pumping ? 1 : 0)
  }

  /** 列が空になるまで待つ（テスト用） */
  async drain(): Promise<void> {
    while (this.pumping || this.queue.length > 0) await new Promise((r) => setTimeout(r, 5))
  }

  private async pump(): Promise<void> {
    if (this.pumping || !this.summarizer) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const { key, row } = this.queue.shift()!
        // 性格を引くついでに「そもそも作るか」も分かる（メタの読み出しは非同期なので、同期の scan() では引けない。#263）
        const persona = await this.persona(row)
        // 口は 1 件ごとに取り直す（性格を引いている間にも、画面から切られたり口を変えられたりする。#288）
        const summarizer = this.summarizer
        const model = this.modelValue
        if (persona === null || !summarizer) {
          this.queued.delete(key)
          continue
        }
        try {
          const summary = await summarizer.summarize(digestPrompt(persona, row.text))
          await this.store.append({ key, persona, summary, model, ts: new Date().toISOString() })
        } catch (err) {
          await this.log(`${new Date().toISOString()} ${key} ${err instanceof Error ? err.message : String(err)}`)
        } finally {
          this.queued.delete(key)
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private async log(line: string): Promise<void> {
    if (!this.logPath) return
    try {
      await mkdir(dirname(this.logPath), { recursive: true })
      await appendFile(this.logPath, line + '\n', 'utf-8')
    } catch {
      // ログが書けなくても動く
    }
  }
}

/** 全体の既定（settings.json）とセッションのメタ（session-meta.json）から、その行の性格を決める */
export interface PersonaSources {
  settings: { get(): Promise<{ persona: PersonaId }> }
  /** セッションのメタ。無ければ既定だけ */
  meta?: { get(id: string): Promise<{ persona?: PersonaId; digest_off?: true } | undefined> }
}

/**
 * 行 → 性格。セッション（エンティティ）のメタに persona があればそれ、無ければ全体の既定。
 * **そのセッションが `digest_off` なら `null`**（作らない。#263）。
 * メタは 1 行につき 1 回しか読まないので、「作るか」と「どの口調か」をここで一緒に決める
 */
export function personaResolver(sources: PersonaSources): (row: FeedRow) => Promise<PersonaId | null> {
  return async (row) => {
    const own = sources.meta ? await sources.meta.get(entityId(row.session, row.repo, row.ts)) : undefined
    if (own?.digest_off) return null
    return own?.persona ?? (await sources.settings.get()).persona
  }
}

/**
 * 本物の口を作る関数。口とモデルは settings.json（画面）から来て、openai の送り先と鍵だけは環境変数（SAI_DIGEST_URL / SAI_DIGEST_API_KEY）から取る。
 * **送り先を settings.json に入れないのは意図的**（#288）: 入れると同一オリジンの PUT 1 つで、作業の本文を任意の URL に流せるようになる。
 * 組んだら log（既定 stderr）に口とモデルを出す（サーバのペインから、いま何で作っているかが分かる）
 */
export function summarizerFactory(feedDir: string, env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (line) => console.error(line)): SummarizerFactory {
  return (provider, model) => {
    if (provider === 'openai') {
      const url = env.SAI_DIGEST_URL || DEFAULT_OPENAI_URL
      log(`digest: openai ${url} model=${model}`)
      return new OpenAISummarizer(url, model, env.SAI_DIGEST_API_KEY || undefined)
    }
    log(`digest: claude model=${model}`)
    return new ClaudeSummarizer(model, feedDir, env)
  }
}

/** 本物を組む。最初は切で、入切・口・モデルは `configure()` で入る（createApp が起動時に settings.json を渡す） */
export function createDigester(
  feedDir: string,
  store: DigestStore,
  sources: PersonaSources,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.error(line),
): Digester {
  return new Digester(store, summarizerFactory(feedDir, env, log), {
    enabled: false,
    model: '',
    ownDir: feedDir,
    persona: personaResolver(sources),
    logPath: `${feedDir}/digest.log`,
  })
}
