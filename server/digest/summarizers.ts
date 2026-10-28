// 要約の口（#811）。文を渡して要約を返す。一言（digest.ts）のほか、PR の要約（prBrief）と評価の道具（tools/digest-eval/）も使う。
//
// 既定は返信と同じ `claude` CLI を `-p` で叩く（依存を足さない。実行ファイルはサーバの PATH の `claude`）。
// 口を openai にすると OpenAI 互換の HTTP（Ollama / LM Studio / llama.cpp / vLLM）を Node の fetch で叩く。
// 一言の都合（作り直し・2 つで組む・性格）は digest.ts に置き、ここは digest.ts を import しない（循環させない）。
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { childEnv } from '../reply/runner.ts'
import { ClaudeLimitsFile, replyLimitsFile, type ClaudeLimitsSink } from '../reply/claudeLimits.ts'
import type { DigestProvider } from '../../shared/types.ts'

/** 口が openai のときの既定の base URL（Ollama。LM Studio は http://127.0.0.1:1234/v1）。変えるのは SAI_DIGEST_URL だけ */
export const DEFAULT_OPENAI_URL = 'http://127.0.0.1:11434/v1'
/** 1 件あたりの上限。これを超えたら失敗扱い（次の行へ） */
export const DIGEST_TIMEOUT_MS = 90_000

/**
 * `claude -p --output-format json` の 1 回ぶんの数字（#740）。**本文は持たない**。
 * `pnpm digest:eval` が案ごとに集計して、どこで時間がかかっているか（起動まわり／API の中／思考の出力）を切り分ける
 */
export interface SummarizeStats {
  /** CLI が測った全体（ミリ秒）。プロセスの起動は含まない */
  duration_ms: number
  /** そのうち API を待っていた時間（ミリ秒） */
  duration_api_ms: number
  input_tokens: number
  /** キャッシュに書いた入力（毎回書き直すと、ここが大きいまま） */
  cache_write_tokens: number
  cache_read_tokens: number
  /** 出力。**思考も入る**（一言は数十トークンのはずなので、桁が違えば思考） */
  output_tokens: number
  /** API 換算の費用（ドル） */
  cost_usd: number
}

export interface Summarizer {
  /** prompt を渡して一言を返す。空文字や失敗は throw（呼び出し側が「無いまま」にする） */
  summarize(prompt: string): Promise<string>
  /** どこに投げているか（口の不調を画面に出すときに添える。例 `http://127.0.0.1:11434/v1`）。無くてよい */
  readonly where?: string
  /** 直前の 1 回の数字（取れる口だけ。取れなければ無い）。順に呼ぶ道具（`pnpm digest:eval`）が読む */
  readonly lastStats?: SummarizeStats | undefined
}

/** `--output-format json` の出力から数字だけを抜く。数字が 1 つも無ければ `undefined` */
export function summarizeStats(parsed: unknown): SummarizeStats | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined
  const o = parsed as Record<string, unknown>
  const usage = (o.usage && typeof o.usage === 'object' ? o.usage : {}) as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  if (typeof o.duration_ms !== 'number' && typeof usage.output_tokens !== 'number') return undefined
  return {
    duration_ms: num(o.duration_ms),
    duration_api_ms: num(o.duration_api_ms),
    input_tokens: num(usage.input_tokens),
    cache_write_tokens: num(usage.cache_creation_input_tokens),
    cache_read_tokens: num(usage.cache_read_input_tokens),
    output_tokens: num(usage.output_tokens),
    cost_usd: num(o.total_cost_usd),
  }
}

/**
 * 一言の `claude -p` から外すもの（#740）。一言は文を 1 つ返すだけなので、道具・MCP・スキルの一覧は要らない。
 * 何も指定しないと claude.ai のコネクタと道具の一覧がそのまま載り、**文脈が 2.7 万トークン**（うち 1 万前後を毎回書き直す）になった
 * （Claude Code 2.1.292 で実測。外すと 0.76 万）。**足すのは減らす側のフラグだけ**で、権限のフラグは足さない。
 *
 * **利用者の設定ファイルは読むまま**にする（`--setting-sources ""` は付けない）: 付けるとさらに 2〜3 秒縮むが、設定の `env`
 * （プロキシ・`ANTHROPIC_BASE_URL`・Bedrock の指定・モデルの読み替え）が効かなくなり、OAuth のログインがあると
 * **落ちずに別の経路で本文を送る**（#746 のレビュー。利用者が決めた送り先を黙って変えない）
 */
export const SUMMARIZE_LIGHT_ARGS: readonly string[] = [
  // 道具を渡さない
  '--tools',
  '',
  // MCP を繋がない（利用者・プロジェクトの設定のものも、claude.ai のコネクタも）
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  // スラッシュコマンド・スキルの一覧を載せない
  '--disable-slash-commands',
]

/**
 * 思考を切る（#740）。一言は 80 字なのに、既定のままだと**答え 25〜69 字に対して出力が 1,750〜7,112 トークン**出て、
 * 1 回 30〜85 秒かかり 90 秒の時間切れに掛かった（haiku・6 件の実測。切ると出力 32〜75 トークン・全体 5〜8 秒）。
 * `--effort low` では減らなかった。手元の口（qwen3）で切ってあるのと同じ理由（`REASONING_OFF`）。
 * 環境変数なので、知らない版の CLI でも落ちない（効かないだけ）
 */
export const SUMMARIZE_ENV: Readonly<Record<string, string>> = { MAX_THINKING_TOKENS: '0', CLAUDE_CODE_DISABLE_THINKING: '1' }

/**
 * 軽い形の出力の形（#832）。stream-json にすると、API の応答ごとの `rate_limit_event`（使用率）が出力に流れるので、
 * 返信と同じく `usage-claude-replies.json` に残せる（使用率のためだけの `-p` は作らない）。`-p` で stream-json を出すには
 * `--verbose` が要る（返信の `CLAUDE_STREAM_ARGS` と同じ）。最後の `result` の行は json の出力と同じ中身
 */
export const SUMMARIZE_STREAM_ARGS: readonly string[] = ['--output-format', 'stream-json', '--verbose']

/**
 * `claude -p` の起動引数。テストで並びを見る。実行ファイルはサーバの PATH の `claude`（#288）。
 * `light: false` は外すフラグを付けない前の形（知らないフラグで落ちる版の CLI のための戻り先。出力も前の json のまま）
 */
export function summarizeCommand(model: string, light = true): { bin: string; args: string[] } {
  // --bare は OAuth を読まないので使えない（Not logged in になる）。フックは AGENT_FEED_SKIP=1 で黙らせる
  return {
    bin: 'claude',
    args: light
      ? ['-p', '--model', model, ...SUMMARIZE_STREAM_ARGS, '--no-session-persistence', ...SUMMARIZE_LIGHT_ARGS]
      : ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence'],
  }
}

/**
 * `claude -p` の出力 → 結果の 1 つ（#832）。json の出力（全体で 1 つ）と stream-json（1 行 1 つ。最後の `type: "result"` の行）の
 * どちらも読む。読めなければ null（呼び出し側が `exit N: …` にする）
 */
export function resultOf(stdout: string): { is_error?: boolean; result?: unknown } | null {
  try {
    const whole = JSON.parse(stdout) as unknown
    if (whole && typeof whole === 'object' && !Array.isArray(whole)) return whole as { is_error?: boolean; result?: unknown }
  } catch {
    // stream-json（複数行）
  }
  let found: { is_error?: boolean; result?: unknown } | null = null
  for (const line of stdout.split('\n')) {
    if (!line.includes('"result"')) continue
    try {
      const row = JSON.parse(line) as { type?: unknown }
      if (row && typeof row === 'object' && row.type === 'result') found = row as { is_error?: boolean; result?: unknown }
    } catch {
      // 書きかけの行
    }
  }
  return found
}

/** 前の形でも通らなかったあと、次に前の形を試すまで */
export const FALLBACK_RETRY_MS = 10 * 60_000

/**
 * 軽い形の失敗が**起こし方のせい**か（#740）。前の形を試すのはこのときだけ:
 * CLI が JSON を返さずに終わった（知らないフラグで即終了する版。`exit N: …`）。
 * API の失敗・空の答え（`claude: …`）と時間切れは起こし方のせいではない
 */
export function formFailure(err: unknown): boolean {
  return err instanceof Error && /^exit /.test(err.message)
}

export interface ClaudeSummarizerOptions {
  /** 外すフラグを付けない前の形で起こす（`pnpm digest:eval --claude-legacy` が前後を比べるのに使う）。思考を切る指定も付けない */
  legacy?: boolean
  /** 前の形へ戻したときの知らせ（引数は軽い形が落ちた理由の頭）。既定は捨てる（本物は `summarizerFactory` がサーバの stderr に出す） */
  onFallback?: (reason: string) => void
  timeoutMs?: number
  /** 実行ファイル。既定はサーバの PATH の `claude`。テストは偽物を渡す */
  bin?: string
  /** 出力に流れた使用率（`rate_limit_event`）を渡す先（#832）。無ければ捨てる */
  limits?: ClaudeLimitsSink
}

/** 本物。`claude -p` にプロンプトを stdin で渡し、JSON の result を取る */
export class ClaudeSummarizer implements Summarizer {
  private readonly model: string
  private readonly cwd: string
  private readonly env: NodeJS.ProcessEnv
  private readonly legacy: boolean
  private readonly onFallback: (reason: string) => void
  private readonly timeoutMs: number
  private readonly bin: string | undefined
  private readonly limits: ClaudeLimitsSink | undefined
  /**
   * 軽い形が通らなかったので、前の形で起こしている（このプロセスの間は覚える。毎回 2 本起こさない）。
   * 知らないフラグで落ちる版の CLI のため
   */
  private fellBack = false
  /** 前の形でも通らなかった。しばらくは前の形を試さない（切れている間、毎回 2 本起こさない） */
  private noRetryUntil = 0
  lastStats: SummarizeStats | undefined

  get where(): string {
    return `claude -p --model ${this.model}`
  }

  constructor(model: string, cwd: string, env: NodeJS.ProcessEnv = process.env, opts: ClaudeSummarizerOptions = {}) {
    this.model = model
    this.cwd = cwd
    this.env = env
    this.legacy = opts.legacy ?? false
    this.onFallback = opts.onFallback ?? (() => {})
    this.timeoutMs = opts.timeoutMs ?? DIGEST_TIMEOUT_MS
    this.bin = opts.bin
    this.limits = opts.limits
  }

  async summarize(prompt: string): Promise<string> {
    if (this.legacy || this.fellBack) return this.run(prompt, false, this.timeoutMs)
    const started = Date.now()
    try {
      return await this.run(prompt, true, this.timeoutMs)
    } catch (err) {
      // 前の形を試すのは、**起こし方のせいで落ちた**ときだけ（`formFailure()`）。時間切れ・API の一時的な失敗・空の答えでは試さない
      // （試して通ると、以後ずっと遅い前の形に戻ってしまう。#746 のレビュー）
      if (!formFailure(err) || Date.now() < this.noRetryUntil) throw err
      // 待つのは合わせて 1 件ぶんまで（2 回目に新しく数えると、1 行で列を 2 倍の時間ふさぐ）
      const left = this.timeoutMs - (Date.now() - started)
      if (left <= 0) throw err
      let text: string
      try {
        text = await this.run(prompt, false, left)
      } catch {
        // 前の形でも通らない（ログイン切れ・モデル名の間違いなど）: しばらく試さず、最初の理由を返す
        this.noRetryUntil = Date.now() + FALLBACK_RETRY_MS
        throw err
      }
      this.fellBack = true
      this.onFallback(err instanceof Error ? err.message.slice(0, 120) : String(err))
      return text
    }
  }

  private run(prompt: string, light: boolean, timeoutMs: number): Promise<string> {
    const { bin, args } = summarizeCommand(this.model, light)
    this.lastStats = undefined
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.bin ?? bin, args, {
        cwd: this.cwd,
        // フック（record.py）に「記録するな」を伝える。この子が Stop の行として載るのを防ぐ。
        // 万一記録されても、SAI が起動した子なのでサーバのペインは継がせない（childEnv。#234）
        env: { ...childEnv(this.env), AGENT_FEED_SKIP: '1', ...(light ? SUMMARIZE_ENV : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`timeout after ${this.timeoutMs}ms`))
      }, timeoutMs)
      child.stdout.on('data', (b: Buffer) => out.push(b))
      child.stderr.on('data', (b: Buffer) => err.push(b))
      // 子が先に入力を閉じても落ちない（知らないフラグで即終了する版）
      child.stdin.on('error', () => {})
      child.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        const stdout = Buffer.concat(out).toString('utf-8')
        // 使用率は答えが失敗でも拾う（API が返していれば口座の値）。書けなくても一言は止めない
        if (this.limits) {
          try {
            this.limits.observe(stdout)
            this.limits.flush()
          } catch {
            // あれば嬉しい程度のもの
          }
        }
        const parsed = resultOf(stdout)
        if (!parsed) return reject(new Error(`exit ${code}: ${(Buffer.concat(err).toString('utf-8') || stdout).trim().slice(0, 200)}`))
        this.lastStats = summarizeStats(parsed)
        const result = typeof parsed.result === 'string' ? parsed.result.trim() : ''
        if (parsed.is_error || !result) return reject(new Error(`claude: ${result || 'empty result'}`))
        resolve(result)
      })
      child.stdin.end(prompt)
    })
  }
}

/**
 * 思考つきのモデル（qwen3 など）の思考を切る指定。一言は 40 文字なので思考は要らないのに、既定のままだと
 * 本文の何倍もの思考を先に生成して 90 秒の timeout に掛かり、1 → 5 → 30 分後に作り直すあいだ GPU を占有し続ける
 * （実測: 同じ依頼が思考あり 11 秒・416 トークン、無し 0.9 秒・30 トークン。Mac 全体が重くなって一覧が 38 秒になった）。
 * Ollama の OpenAI 互換の口で効くのはこれだけ（`think: false` と `/no_think` は無視され、`max_tokens` は思考に食われて本文が空になる）。
 * 受けない口（OpenAI 本家の推論でないモデル、知らないキーを 422 で弾く厳格なサーバ、`none` という値を受けない o 系など）は
 * 4xx を返すので、そのときは外して送り直す（OpenAISummarizer）
 */
export const REASONING_OFF = { reasoning_effort: 'none' } as const

/** `POST <base>/chat/completions` の組み立て。テストで形を見る。末尾の `/` は有っても無くてもよい。`reasoningOff: false` で思考を切る指定を付けない */
export function summarizeRequest(baseUrl: string, model: string, prompt: string, apiKey?: string, opts: { reasoningOff?: boolean } = {}): { url: string; init: RequestInit } {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const reasoningOff = opts.reasoningOff ?? true
  return {
    url: `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, ...(reasoningOff ? REASONING_OFF : {}) }),
    },
  }
}

/**
 * 思考を切る指定を外して送り直してみる 4xx か。口ごとに文言が違う（OpenAI 本家は 400 で引数名を挙げる、
 * 厳格なサーバは 422 `Extra inputs are not permitted`、素っ気ないものは `invalid request`）ので本文は見ず、
 * **「要求の形が悪い」を意味する 400 / 422 のときだけ** 1 回外して送り直す。
 * 401 / 403 / 404 / 413（鍵・モデル名・大きさの間違い）は指定のせいではないので送り直さない（大きなプロンプトを 2 回送らない）。
 * 408 / 409 / 425 / 429（混んでいる・一時的）も送り直さない（外して通っても指定のせいではなく、覚えると思考が永久に戻る。#500 のレビュー）
 */
export function mayRetryWithoutReasoning(status: number): boolean {
  return status === 400 || status === 422
}

/** 失敗の本文の切り出し。投げる文とログの文で同じ形 */
const httpError = (r: { res: Response; body: string }): string => `HTTP ${r.res.status}: ${r.body.trim().slice(0, 200)}`

export interface OpenAISummarizerOptions {
  apiKey?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
  /** `reasoning_effort` を外したときの知らせ。既定は捨てる（本物は `summarizerFactory` がサーバの stderr に出す） */
  log?: (line: string) => void
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
  private readonly log: (line: string) => void
  /**
   * この口が `reasoning_effort` を 4xx で断り、外したら通った。以後は付けずに送る（毎回 2 往復しない）。
   * **外して通ったときだけ**立てる（付けたままの 4xx が別の理由なら、外しても通らないので立てない）。
   * この口（インスタンス）だけの覚えで、`Digester.configure()` が口を作り直したら（設定を変えた・立て直した）もう一度確かめる
   */
  private reasoningRejected = false

  get where(): string {
    return this.baseUrl
  }

  constructor(baseUrl: string, model: string, opts: OpenAISummarizerOptions = {}) {
    this.baseUrl = baseUrl
    this.model = model
    this.apiKey = opts.apiKey
    this.timeoutMs = opts.timeoutMs ?? DIGEST_TIMEOUT_MS
    this.fetchFn = opts.fetchFn ?? fetch
    this.log = opts.log ?? (() => {})
  }

  async summarize(prompt: string): Promise<string> {
    // 1 件あたりの上限は送り直しを含めて DIGEST_TIMEOUT_MS（signal は 1 つ。2 回目に新しく作ると 2 倍まで待ってしまう）
    const signal = AbortSignal.timeout(this.timeoutMs)
    const send = async (reasoningOff: boolean) => {
      const { url, init } = summarizeRequest(this.baseUrl, this.model, prompt, this.apiKey, { reasoningOff })
      const res = await this.fetchFn(url, { ...init, signal })
      return { res, body: await res.text() }
    }
    const first = await send(!this.reasoningRejected)
    let last = first
    if (!first.res.ok && !this.reasoningRejected && mayRetryWithoutReasoning(first.res.status)) {
      // 思考を切る指定を受けない口かもしれない。外して 1 回だけ送り直し、通ったらこの口には以後付けない。
      // 送り直しが timeout や通信で落ちたら、最初の 4xx の理由を添えて投げる（timeout の文だけでは原因が見えない）
      try {
        last = await send(false)
      } catch (err) {
        throw new Error(`${httpError(first)}; reasoning_effort なしで送り直し: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
      }
      if (last.res.ok) {
        this.reasoningRejected = true
        this.log(`digest: ${this.baseUrl} は reasoning_effort を受けない（${httpError(first)}）。以後この口には付けずに送る（思考つきのモデルなら思考が入る）`)
      }
    }
    if (!last.res.ok) throw new Error(httpError(last))
    const body = last.body
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

/** 口が時間切れで落ちたか（`AbortSignal.timeout()` の `TimeoutError` と、`ClaudeSummarizer` の `timeout after …`） */
export function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || /^timeout after /.test(err.message))
}

/** 口とモデルから Summarizer を作る。`Digester.configure()` が入にしたとき・口やモデルを変えたときに呼ぶ */
export type SummarizerFactory = (provider: DigestProvider, model: string) => Summarizer

/**
 * 本物の口を作る関数。口とモデルは settings.json（画面）から来て、openai の送り先と鍵だけは環境変数（SAI_DIGEST_URL / SAI_DIGEST_API_KEY）から取る。
 * **送り先を settings.json に入れないのは意図的**（#288）: 入れると同一オリジンの PUT 1 つで、作業の本文を任意の URL に流せるようになる。
 * 組んだら log（既定 stderr）に口とモデルを出す（サーバのペインから、いま何で作っているかが分かる）
 */
export function summarizerFactory(
  feedDir: string,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.error(line),
  limits?: ClaudeLimitsSink,
): SummarizerFactory {
  return (provider, model) => {
    if (provider === 'openai') {
      const url = env.SAI_DIGEST_URL || DEFAULT_OPENAI_URL
      log(`digest: openai ${url} model=${model}`)
      return new OpenAISummarizer(url, model, { apiKey: env.SAI_DIGEST_API_KEY || undefined, log })
    }
    log(`digest: claude model=${model}`)
    return new ClaudeSummarizer(model, feedDir, env, { limits, onFallback: (reason) => log(`digest: claude の軽い形が通らなかったので、前の形で起こします（${reason}）`) })
  }
}

/** 一言・PR の要約の `claude -p` の出力から拾った使用率の置き場（#832）。返信と同じ `usage-claude-replies[.<host>].json` */
export function summarizeLimits(feedDir: string, env: NodeJS.ProcessEnv = process.env): ClaudeLimitsSink {
  return new ClaudeLimitsFile(join(feedDir, replyLimitsFile(env)))
}
