// チャットの一言コメント（digest）。エージェントの返答（text）を、性格つきの 1〜2 文に言い換える。
//
// 作るのは LLM で、既定は返信と同じ `claude` CLI を `-p` で叩く（依存を足さない。SAI_CLAUDE_BIN も効く）。
// SAI_DIGEST_PROVIDER=openai なら OpenAI 互換の HTTP（Ollama / LM Studio / llama.cpp / vLLM）を Node の fetch で叩く。
// 結果は ~/.agent-feed/digest.jsonl に追記し、JSONL（記録）は触らない。派生データなので消しても履歴は壊れない。
// 既定はオフ（SAI_DIGEST=1 で有効）。オンでも「サーバが起動したあとに増えた行」だけ作り、過去の行は作らない。
// 1 行ずつ直列で回し、失敗した行は無いまま（画面は text を出す）。
import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { entityId } from '../shared/entity.ts'
import { eventKind } from '../shared/events.ts'
import { digestPrompt } from '../shared/persona.ts'
import type { DigestProvider, FeedRow, PersonaId } from '../shared/types.ts'

export const DIGEST_FILE = 'digest.jsonl'
export const DEFAULT_DIGEST_MODEL = 'haiku'
/** SAI_DIGEST_PROVIDER=openai のときの既定の base URL（Ollama。LM Studio は http://127.0.0.1:1234/v1） */
export const DEFAULT_OPENAI_URL = 'http://127.0.0.1:11434/v1'
/** 1 件あたりの上限。これを超えたら失敗扱い（次の行へ） */
export const DIGEST_TIMEOUT_MS = 90_000

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

/** `claude -p` の起動引数。テストで並びを見る */
export function summarizeCommand(model: string, env: NodeJS.ProcessEnv = process.env): { bin: string; args: string[] } {
  // --bare は OAuth を読まないので使えない（Not logged in になる）。フックは AGENT_FEED_SKIP=1 で黙らせる
  return {
    bin: env.SAI_CLAUDE_BIN || 'claude',
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
    const { bin, args } = summarizeCommand(this.model, this.env)
    return new Promise<string>((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: this.cwd,
        // フック（record.py）に「記録するな」を伝える。この子が Stop の行として載るのを防ぐ
        env: { ...this.env, AGENT_FEED_SKIP: '1' },
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

export interface DigesterOptions {
  enabled: boolean
  model: string
  /** 一言を作る口。表示用（/api/settings の provider）。無ければ claude */
  provider?: DigestProvider
  /** 一言を作る子プロセスの cwd（フィードのディレクトリ）。ここを cwd にした行は自分の雑音なので作らない */
  ownDir?: string
  /** その行の性格。作る直前に行ごとに引く（セッションのメタに persona があればそれ、無ければ全体の既定。変えたら以後の行から効く） */
  persona: (row: FeedRow) => Promise<PersonaId>
  /** 失敗の記録先（無ければ捨てる） */
  logPath?: string
}

export class Digester {
  readonly store: DigestStore
  readonly enabled: boolean
  readonly model: string
  readonly provider: DigestProvider
  private readonly summarizer: Summarizer | null
  private readonly persona: (row: FeedRow) => Promise<PersonaId>
  private readonly logPath: string | undefined
  private readonly ownDir: string | undefined
  /** 起動時に既にあった行。作らない（過去の行の一括生成はしない） */
  private baseline: Set<string> | null = null
  private queue: { key: string; row: FeedRow }[] = []
  private queued = new Set<string>()
  private pumping = false

  constructor(store: DigestStore, summarizer: Summarizer | null, opts: DigesterOptions) {
    this.store = store
    this.summarizer = summarizer
    this.enabled = opts.enabled && summarizer !== null
    this.model = opts.model
    this.provider = opts.provider ?? 'claude'
    this.persona = opts.persona
    this.logPath = opts.logPath
    this.ownDir = opts.ownDir
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
   * いま見えている行を渡す。最初の呼び出しはその時点の行を「既にあった行」として覚えるだけ。
   * 以後、新しく現れた対象の行を新しい順に列に積む。3 秒ごとの応答のついでに呼ばれる前提で、軽い
   */
  scan(rows: FeedRow[]): void {
    if (!this.enabled) return
    if (this.baseline === null) {
      this.baseline = new Set(rows.filter((r) => this.wants(r)).map(digestKey))
      return
    }
    const fresh: { key: string; row: FeedRow }[] = []
    for (const row of rows) {
      if (!this.wants(row)) continue
      const key = digestKey(row)
      if (this.baseline.has(key) || this.queued.has(key) || this.store.get(key)) continue
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
        const persona = await this.persona(row)
        try {
          const summary = await this.summarizer.summarize(digestPrompt(persona, row.text))
          await this.store.append({ key, persona, summary, model: this.model, ts: new Date().toISOString() })
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

/** 全体の既定（settings.json）とセッションのメタ（session-meta.json の persona）から、その行の性格を決める */
export interface PersonaSources {
  settings: { get(): Promise<{ persona: PersonaId }> }
  /** セッションのメタ。無ければ既定だけ */
  meta?: { get(id: string): Promise<{ persona?: PersonaId } | undefined> }
}

/** 行 → 性格。セッション（エンティティ）のメタに persona があればそれ、無ければ全体の既定 */
export function personaResolver(sources: PersonaSources): (row: FeedRow) => Promise<PersonaId> {
  return async (row) => {
    const own = sources.meta ? (await sources.meta.get(entityId(row.session, row.repo, row.ts)))?.persona : undefined
    return own ?? (await sources.settings.get()).persona
  }
}

/**
 * 環境変数から本物を組む。SAI_DIGEST=1 でなければ無効（summarizer は作らない）。
 * 口は SAI_DIGEST_PROVIDER: claude（既定。`claude -p`）か openai（SAI_DIGEST_URL の `/chat/completions`。SAI_DIGEST_MODEL は必須）。
 * 設定の間違いはサーバを落とさず、log（既定 stderr）に理由を出して一言を無効のまま立てる
 */
export function digesterFromEnv(
  feedDir: string,
  store: DigestStore,
  sources: PersonaSources,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.error(line),
): Digester {
  const enabled = env.SAI_DIGEST === '1'
  const providerRaw = env.SAI_DIGEST_PROVIDER || 'claude'
  const provider: DigestProvider = providerRaw === 'openai' ? 'openai' : 'claude'
  const common = { enabled, ownDir: feedDir, persona: personaResolver(sources), logPath: `${feedDir}/digest.log` }

  if (providerRaw !== 'claude' && providerRaw !== 'openai') {
    if (enabled) log(`digest: SAI_DIGEST_PROVIDER=${providerRaw} は知らない口（claude / openai）。一言は作らない`)
    return new Digester(store, null, { ...common, model: env.SAI_DIGEST_MODEL || '', provider })
  }
  if (provider === 'openai') {
    const model = env.SAI_DIGEST_MODEL || ''
    const url = env.SAI_DIGEST_URL || DEFAULT_OPENAI_URL
    if (enabled && !model) {
      log('digest: SAI_DIGEST_PROVIDER=openai には SAI_DIGEST_MODEL が要る（ローカルのモデル名。例 qwen3:8b）。一言は作らない')
      return new Digester(store, null, { ...common, model, provider })
    }
    if (enabled) log(`digest: openai ${url} model=${model}`)
    return new Digester(store, enabled ? new OpenAISummarizer(url, model, env.SAI_DIGEST_API_KEY || undefined) : null, { ...common, model, provider })
  }
  const model = env.SAI_DIGEST_MODEL || DEFAULT_DIGEST_MODEL
  if (enabled) log(`digest: claude model=${model}`)
  return new Digester(store, enabled ? new ClaudeSummarizer(model, feedDir, env) : null, { ...common, model, provider })
}
