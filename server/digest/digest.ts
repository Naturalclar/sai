// チャットの一言コメント（digest）。エージェントの返答（text）を、性格つきの 1〜2 文に言い換える。
//
// 作るのは LLM で、既定は返信と同じ `claude` CLI を `-p` で叩く（依存を足さない。実行ファイルはサーバの PATH の `claude`）。
// 口を openai にすると OpenAI 互換の HTTP（Ollama / LM Studio / llama.cpp / vLLM）を Node の fetch で叩く。
// 結果は ~/.agent-feed/digest.jsonl に追記し、JSONL（記録）は触らない。派生データなので消しても履歴は壊れない。
// 既定はオフ。入切・口・モデルは settings.json（画面の自分のメニュー）で、サーバを立て直さずに切り替わる（#288。前は環境変数）。
// 入でも「入にしたあと（起動時に入なら起動したあと）に増えた行」だけ作り、過去の行は作らない。
// 1 行ずつ直列で回す。失敗した行は間を置いて作り直し（1 → 5 → 30 分）、DIGEST_MAX_TRIES 回で諦めて無いままにする
// （画面は text を出す）。前は失敗した行を次の scan() がすぐ積み直し、口が落ちている間ずっと同じ行を 90 秒ごとに叩いていた（#443）。
// 続けて DIGEST_ALERT_FAILS 回失敗したら、口の不調を `error`（画面の digest_error）に出し、列を進めずに DIGEST_BREAK_MS 休む（#497）。
import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { entityId } from '../../shared/entity.ts'
import { eventKind } from '../../shared/events.ts'
import { DEFAULT_PERSONA, DIGEST_MAX_CHARS, digestPrompt, digestWhatPrompt } from '../../shared/persona.ts'
import type { DigestRetry } from '../../shared/persona.ts'
import { digestIssues } from '../../shared/digestCheck.ts'
import { digestKey } from '../../shared/digestFeedback.ts'
import { needsFullText } from '../../shared/fullText.ts'
import { fullTextJudgePrompt, parseFullTextJudge } from '../../shared/fullTextJudge.ts'
import { composeNextAsk, quotedNextAsk } from '../../shared/nextAsk.ts'
import type { ComposedNextAsk } from '../../shared/nextAsk.ts'
import type { NextAskIssueCode } from '../../shared/nextAskCheck.ts'
import { cleanWhat, digestPlan, joinDigest } from '../../shared/digestParts.ts'
import type { DigestIssueCode } from '../../shared/digestCheck.ts'
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
/**
 * 失敗した行を作り直すまでの間隔（#443）。n 回目の失敗のあと `DIGEST_RETRY_DELAYS_MS[n - 1]` 待つ。
 * 口が落ちている間に同じ行を 90 秒ごとに叩き続けない（そのあいだ新しい順の列の先頭を占めて、ほかの行の一言も作られない）
 */
export const DIGEST_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000]
/** この回数失敗した行は諦める（作らないまま。digest.log に「諦めた」と残す） */
export const DIGEST_MAX_TRIES = DIGEST_RETRY_DELAYS_MS.length + 1
/** 続けてこの回数失敗したら、口の不調を `error` に出す（成功したら消える） */
export const DIGEST_ALERT_FAILS = 3
/**
 * 続けて DIGEST_ALERT_FAILS 回失敗したら、**列を進めずに**この間だけ口を休ませる（#497。遮断器）。
 * 作り直しの間隔（DIGEST_RETRY_DELAYS_MS）は**行ごと**なので、思考を切る指定を無視する口（LM Studio など）では
 * 新しい行が来るたびに 90 秒の timeout まで GPU を占有し続けた（#494 の前に Mac 全体を重くしていた形）。
 * 休み明けは 1 件だけ試し、通れば平常に戻り、また落ちればもう一度休む
 */
export const DIGEST_BREAK_MS = 5 * 60_000

export interface DigestEntry {
  /** 行を一意に指す。`<entityId>|<ts>` */
  key: string
  persona: PersonaId
  /**
   * 一言。**空なら一言は作っていない**（#560。一言を切っていて、次の案だけ作った行。作らなかった行を鍵で覚えて、
   * 3 秒ごとの scan() が同じ行を積み直さないようにする）。読む側は空を「一言なし」として扱う
   */
  summary: string
  /**
   * 2 つで組んだ一言（#713）の中身: `what` = 何が起きたか（口が書いた。性格の口調つき）、`next` = 人が次にすること
   * （**本文の文そのまま**。口調なし）。`summary` はこの 2 つを繋いだもの。本文に人への頼みの文が無い回・
   * この欄が入る前の行には付かない（`summary` をそのまま 1 つの一言として読む）
   */
  what?: string
  next?: string
  model: string
  /** 作った時刻 */
  ts: string
  /** 1 回目が機械の判定に引っかかって作り直した（#346）。引っかからなければ付けない */
  retried?: true
  /** 作り直しても残った点（`digestIssues()` の code）。無ければ付けない */
  issues?: DigestIssueCode[]
  /**
   * 次に送る文面の案（#371）。一言と同じ口でもう 1 回呼んで作る。
   * **そのセッションの一番新しい行の分だけ**で、作れなければ付けない
   */
  next_ask?: string
  /**
   * 案の出どころ（#713）。`quote` = 本文に引用された言葉（「『〜』と言ってください」）をそのまま採った（LLM を呼んでいない）。
   * 口で作った案・案の無い行には付けない（この欄が入る前の行も、口で作ったもの）
   */
  next_ask_source?: 'quote'
  /**
   * 口で作った案が人の返信として読めず（`nextAskIssues()`）、作り直した（#729）。作り直して出した案にも、出さなかった行にも付く
   */
  next_ask_retried?: true
  /**
   * 作り直しても残り、**案を出さなかった**理由（#729。`nextAskIssues()` の code）。`next_ask` は付かない。
   * 「作れなかった」（口の失敗・空）と「わざと出さなかった」を、あとから数え分けるために残す
   */
  next_ask_dropped?: NextAskIssueCode[]
  /**
   * 一言を**わざと作らなかった**理由（#638）。`asking` = 人に判断・回答を求めている返答（`needsFullText()`）なので、
   * 言い換えずに本文をそのまま出す。`judged` = 規則は当てなかったが、一言を作っている手元のモデルが「全文が要る」と答えた（#639）。
   * `summary` は空。**一言を切っていて作らなかった行（#560）と違い、積み直さない**
   */
  skipped?: 'asking' | 'judged'
  /**
   * 手元のモデルに「要約で足りるか」を聞いた答え（#639）。聞かなかった行・答えが読めなかった行には付けない。
   * `summary` の行も残すのは、あとで「詳細を開いた」の合図と突き合わせるため（`feed/digest_stats.py`）
   */
  judge?: 'full' | 'summary'
}

/** 画面に渡す一言（#713）。`next` が無ければ `what` が一言の全部 */
export interface DigestParts {
  what: string
  next?: string
}

/**
 * `digest.jsonl` の行 → 画面に渡す形。一言が空（案だけ作った行。#560）なら undefined。
 * **`what` と `next` が両方そろっている行だけ**を 2 つとして渡す（片方だけの行は、繋いである `summary` を 1 つの一言として渡す）
 */
export function partsOf(e: Pick<DigestEntry, 'summary' | 'what' | 'next'>): DigestParts | undefined {
  if (!e.summary) return undefined
  return e.what?.trim() && e.next?.trim() ? { what: e.what, next: e.next } : { what: e.summary }
}

/** 行のキー。行は (エンティティ, ts) で一意。**画面と同じものを使う**（shared/digestFeedback.ts。#346） */
export { digestKey }

/** 一言を作る対象か。ターン完了で本文がある行だけ（待ちの行・入力の行・本文なしは作らない） */
export function digestable(row: FeedRow): boolean {
  return eventKind(row.event, row.text) === 'turn' && Boolean(row.text?.trim())
}

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
 * `claude -p` の起動引数。テストで並びを見る。実行ファイルはサーバの PATH の `claude`（#288）。
 * `light: false` は外すフラグを付けない前の形（知らないフラグで落ちる版の CLI のための戻り先）
 */
export function summarizeCommand(model: string, light = true): { bin: string; args: string[] } {
  // --bare は OAuth を読まないので使えない（Not logged in になる）。フックは AGENT_FEED_SKIP=1 で黙らせる
  return {
    bin: 'claude',
    args: ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence', ...(light ? SUMMARIZE_LIGHT_ARGS : [])],
  }
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
        let parsed: { is_error?: boolean; result?: unknown } | null = null
        try {
          parsed = JSON.parse(stdout) as { is_error?: boolean; result?: unknown }
        } catch {
          parsed = null
        }
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
  /**
   * 次に送る文面の案を作るか（#560）。一言とは別に入切する（口とモデルは一言と同じ）。
   * **省略なら `digest` に従う**（#560 より前の settings.json は案の入切を持たず、一言と一緒に動いていた）
   */
  next_ask?: boolean
  digest_provider: DigestProvider
  /** 空なら口の既定（claude は haiku。openai は既定が無いので作らない） */
  digest_model: string
}

export interface DigesterOptions {
  /** 最初の一言の入切。あとから `configure()` で変わる */
  enabled: boolean
  /** 最初の案の入切（#560）。省略なら `enabled` と同じ */
  nextAsk?: boolean
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
  /** 時計（テストが再試行の間隔を進める。#443） */
  now?: () => number
}

export class Digester {
  readonly store: DigestStore
  private readonly make: SummarizerFactory | null
  /** いまの口。null なら作らない（一言も案も切っている・組めなかった） */
  private summarizer: Summarizer | null
  /** 一言を作るか（#560。口は一言と案で 1 つ。どちらかが入なら組む） */
  private summaryOn: boolean
  /** 次に送る文面の案を作るか（#560） */
  private askOn: boolean
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
  /** エンティティごとに、いま見えている中で一番新しい対象の行の ts（#371。案を作る行を絞る） */
  private latest = new Map<string, string>()
  private queue: { key: string; row: FeedRow }[] = []
  private queued = new Set<string>()
  private pumping = false
  private readonly now: () => number
  /** 失敗した行（鍵 → 失敗した回数と、次に作り直してよい時刻）。scan() はそれより前には積まない（#443） */
  private failed = new Map<string, { count: number; next: number }>()
  /**
   * 続けて失敗した**行**（鍵）と、最後の失敗の理由。成功したら空に戻す。回数ではなく行で数えるのは、
   * 1 行だけ毎回断られる（口は元気）ときに、その行の作り直しで「口が応答していません」を出さないため（#487 のレビュー）
   */
  private failStreak = new Set<string>()
  private lastFailure = ''
  /** この時刻までは列を進めない（#497。0 なら休んでいない） */
  private breakUntil = 0
  /** configure() のたびに進める。前の口で走っていた 1 件の結果を、新しい口の数えに混ぜない（#487 のレビュー） */
  private generation = 0

  /**
   * `summarizer` は固定の口（テストの偽物）か、口とモデルから作る関数（本物。`createDigester()`）。null なら入にできない。
   * `opts` の enabled / model / provider は最初の状態で、`configure()` で変わる
   */
  constructor(store: DigestStore, summarizer: Summarizer | SummarizerFactory | null, opts: DigesterOptions) {
    this.store = store
    this.make = summarizer === null ? null : typeof summarizer === 'function' ? summarizer : () => summarizer
    this.modelValue = opts.model
    this.providerValue = opts.provider ?? 'claude'
    this.summaryOn = opts.enabled
    this.askOn = opts.nextAsk ?? opts.enabled
    this.summarizer = (this.summaryOn || this.askOn) && this.make ? this.make(this.providerValue, this.modelValue) : null
    this.persona = opts.persona
    this.logPath = opts.logPath
    this.ownDir = opts.ownDir
    this.now = opts.now ?? Date.now
    const since = opts.since === undefined ? this.now() : Date.parse(opts.since)
    this.sinceMs = (Number.isNaN(since) ? this.now() : since) - DIGEST_SINCE_SLACK_MS
  }

  /** 一言をいま作っているか（入にしていて、口が組めた） */
  get enabled(): boolean {
    return this.summarizer !== null && this.summaryOn
  }

  /** 次に送る文面の案をいま作っているか（#560。入にしていて、口が組めた） */
  get nextAskEnabled(): boolean {
    return this.summarizer !== null && this.askOn
  }

  /** 一言か案のどちらかを作っている＝行を見て列を回す（#560） */
  get active(): boolean {
    return this.summarizer !== null
  }

  /** 実際に使うモデル（空の設定なら口の既定を入れたもの） */
  get model(): string {
    return this.modelValue
  }

  get provider(): DigestProvider {
    return this.providerValue
  }

  /**
   * 入にしたのに作れない理由。無ければ空。設定の誤り（openai でモデルが空など）に加えて、
   * **口が続けて DIGEST_ALERT_FAILS 回失敗したら**その様子も出す（#443。Ollama が止まっていても「入」のまま気づけなかった）
   */
  get error(): string {
    if (this.errorValue) return this.errorValue
    if (!this.summarizer || this.failStreak.size < DIGEST_ALERT_FAILS) return ''
    const where = this.summarizer.where ? `。${this.summarizer.where}` : ''
    const rest = this.breakUntil - this.now()
    const resume = rest > 0 ? `。${Math.ceil(rest / 60_000)} 分後に再開` : ''
    return `一言の口が応答していません（直近 ${this.failStreak.size} 件続けて失敗: ${this.lastFailure}${where}）${resume}`
  }

  /**
   * 入切・口・モデルを変える。起動時（settings.json）と PUT /api/settings から呼び、サーバは立て直さない（#288）。
   * - **切から入にしたら、境目を「いま」に進める**。切っていた間に届いた行はさかのぼって作らない（起動時に入にしたのと同じ扱い。
   *   さかのぼると、入にした瞬間に何日ぶんもの行が列に積まれて口を占有する）
   * - 切ったら列を捨てる（作りかけの 1 件だけは、その口で終わらせる）
   * - openai の口でモデルが空なら作らず、理由を `error` に出す（サーバは落とさない）
   */
  configure(next: DigestSettings): void {
    const was = this.active
    const summaryWas = this.enabled
    this.providerValue = next.digest_provider
    this.modelValue = next.digest_model || (next.digest_provider === 'claude' ? DEFAULT_DIGEST_MODEL : '')
    this.errorValue = ''
    this.summarizer = null
    // 口やモデルを変えたら（入れ直しも）、失敗の数え直し。新しい口で、諦めた行にももう一度だけ機会をやる
    this.failed.clear()
    this.failStreak.clear()
    this.lastFailure = ''
    this.breakUntil = 0
    this.generation += 1
    this.summaryOn = next.digest
    this.askOn = next.next_ask ?? next.digest
    if (this.summaryOn || this.askOn) {
      if (!this.make) this.errorValue = '一言を作る口がありません'
      else if (!this.modelValue) this.errorValue = 'openai の口にはモデル名が要ります（ローカルのモデル名。例 qwen3:8b）'
      else this.summarizer = this.make(this.providerValue, this.modelValue)
    }
    if (!this.active) {
      for (const q of this.queue) this.queued.delete(q.key)
      this.queue = []
    } else if (!was || (this.enabled && !summaryWas)) {
      // 案だけ作っていた間の行も、一言を入にした瞬間にさかのぼって積まない（#560。切から入にしたのと同じ扱い）
      this.sinceMs = this.now() - DIGEST_SINCE_SLACK_MS
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
      // 案だけ作った行（summary が空。#560）には一言を載せない
      const parts = e ? partsOf(e) : undefined
      return parts ? { ...r, summary: parts.what, ...(parts.next ? { summary_next: parts.next } : {}) } : r
    })
  }

  summaryFor(entity: string, ts: string): string | undefined {
    return (ts && this.store.get(`${entity}|${ts}`)?.summary) || undefined
  }

  /**
   * 一言を、画面が場所ごとに出し分けられる形で返す（#713）。2 つで組んだ行は `what`（何が起きたか）と `next`
   * （人が次にすること）、そうでない行（報告だけ・今までのプロンプト・前の一言）は `what` に一言の全部で `next` は無い
   */
  partsFor(entity: string, ts: string): DigestParts | undefined {
    const e = ts ? this.store.get(`${entity}|${ts}`) : undefined
    return e ? partsOf(e) : undefined
  }

  /** 次に送る文面の案（#371）。一言と同じ行に入っている */
  nextAskFor(entity: string, ts: string): string | undefined {
    return ts ? this.store.get(`${entity}|${ts}`)?.next_ask : undefined
  }

  private entityOf(row: FeedRow): string {
    return entityId(row.session ?? '', row.repo ?? '', row.ts)
  }

  private noteLatest(row: FeedRow): void {
    const entity = this.entityOf(row)
    const seen = this.latest.get(entity)
    if (!seen || seen < row.ts) this.latest.set(entity, row.ts)
  }

  /** その行が、そのセッションで一番新しい対象の行か。覚えていなければ（scan を通っていない）作る側に倒す */
  private isLatest(row: FeedRow): boolean {
    const seen = this.latest.get(this.entityOf(row))
    return !seen || seen <= row.ts
  }

  /**
   * 一言にしないほうがよい返答かを、同じ口にもう 1 回聞く（#639）。**聞けない・答えが読めないときは `undefined`**
   * （今までどおり一言を作る。口が落ちているなら、続く一言の呼び出しが失敗として数える）。
   * **timeout だけは投げ直す**（その行の失敗として数える。飲み込むと、口が固まっているときに続く一言でもう 1 回
   * DIGEST_TIMEOUT_MS を待ち、1 行で列を 2 倍の時間ふさぐ。#652 のレビュー）
   */
  private async judgeFullText(row: FeedRow, summarizer: Summarizer, key: string): Promise<'full' | 'summary' | undefined> {
    try {
      const answer = await summarizer.summarize(fullTextJudgePrompt(row.text ?? ''))
      const full = parseFullTextJudge(answer)
      if (full === null) await this.log(`${new Date().toISOString()} ${key} 判定が読めない: ${answer.trim().slice(0, 40)}`)
      return full === null ? undefined : full ? 'full' : 'summary'
    } catch (err) {
      await this.log(`${new Date().toISOString()} ${key} 判定に失敗: ${err instanceof Error ? err.message : String(err)}`)
      if (isTimeout(err)) throw err
      return undefined
    }
  }

  /**
   * 案を 1 つ作る（#713）。本文に人に言ってほしい言葉が引用されていれば、それをそのまま使って口を呼ばない。
   * 無ければ口で作り、人の返信として読めるかを確かめる（#729。駄目なら 1 回だけ作り直し、それでも駄目なら出さない。`composeNextAsk()`）
   */
  private async nextAskOf(row: FeedRow, summarizer: Summarizer): Promise<ComposedNextAsk> {
    const quoted = quotedNextAsk(row.text ?? '')
    if (quoted) return { next_ask: quoted, first: [], dropped: [] }
    // 作り直す前にもう一度見る（1 回目を待つ間に、画面から切られた・次のターンが来た。#288 と同じ扱い）
    return composeNextAsk(row.user_text ?? '', row.text ?? '', (prompt) => summarizer.summarize(prompt), { stillWanted: () => this.askOn && this.active && this.isLatest(row) })
  }

  /** 案を 1 つ。作れなければ空（失敗は digest.log に残し、一言はそのまま出す） */
  private async makeNextAsk(row: FeedRow, summarizer: Summarizer, key: string): Promise<ComposedNextAsk> {
    try {
      return await this.nextAskOf(row, summarizer)
    } catch (err) {
      await this.log(`${new Date().toISOString()} ${key} 次の案に失敗: ${err instanceof Error ? err.message : String(err)}`)
      return { next_ask: '', first: [], dropped: [] }
    }
  }

  /**
   * いま見えている行を渡す。サーバが起動したあとの `ts` を持つ対象の行だけを、新しい順に列に積む。
   * 3 秒ごとの応答のついでに呼ばれる前提で、軽い。
   * 渡される行は呼び出し側（app.ts の scanDigest）の `days` の窓ぶんなので、窓が広がると古い行も入ってくる。
   * 基準が時刻なのでそれらは積まれない（行の集合を基準にすると、窓が広がった瞬間に過去が全部「新しい行」になる。#159）
   */
  scan(rows: FeedRow[]): void {
    if (!this.active) return
    const wanted = rows.filter((row) => this.wants(row))
    // 古い行でも「一番新しいのはどれか」は覚える（案を作る行を決めるのに使う。#371）。
    // 先に全部見てから選ぶ（一言を切っているときは一番新しい行しか積まないので、選ぶ前に決まっていないといけない。#560）
    for (const row of wanted) this.noteLatest(row)
    const fresh: { key: string; row: FeedRow }[] = []
    for (const row of wanted) {
      if (this.isPast(row)) continue
      // 一言を切っていて案だけなら、一番新しい行のほかは作るものが無い（#560）
      if (!this.summaryOn && !this.isLatest(row)) continue
      const key = digestKey(row)
      if (this.queued.has(key)) continue
      // 作ってある行は積まない。ただし**案だけ作った行（一言が空。#560）は、一言を作る側に回ったらもう一度積む**
      // （セッションの「作らない」を戻したとき。前は一言を切っていた行は記録に残らず、戻せば作られていた）
      const done = this.store.get(key)
      // 人に聞いている返答（#638）・手元のモデルが全文が要ると答えた返答（#639）は、一言が空でも積み直さない（わざと作っていない）
      if (done && (done.summary || done.skipped || !this.summaryOn)) continue
      // 失敗した行は、間隔が来るまで・諦めたら積まない（#443）
      const failure = this.failed.get(key)
      if (failure && (failure.count >= DIGEST_MAX_TRIES || this.now() < failure.next)) continue
      fresh.push({ key, row })
    }
    // 休み明けは新しい行が無くても列を進める（休んでいる間に積んだ分が残っている。#497）
    if (fresh.length === 0) {
      if (this.queue.length > 0) void this.pump()
      return
    }
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

  /** 列が空になるか、口を休ませて止まるまで待つ（テスト用） */
  async drain(): Promise<void> {
    while (this.pumping || (this.queue.length > 0 && !this.resting())) await new Promise((r) => setTimeout(r, 5))
  }

  /** 口を休ませている間か（#497） */
  private resting(): boolean {
    return this.now() < this.breakUntil
  }

  private async pump(): Promise<void> {
    if (this.pumping || !this.summarizer) return
    this.pumping = true
    try {
      // 休んでいる間は列を進めない（積んだ行は列に残り、休み明けの scan() が続きを回す。#497）
      while (this.queue.length > 0 && !this.resting()) {
        const { key, row } = this.queue.shift()!
        // 性格を引くついでに「そもそも作るか」も分かる（メタの読み出しは非同期なので、同期の scan() では引けない。#263）
        const persona = await this.persona(row)
        // 口は 1 件ごとに取り直す（性格を引いている間にも、画面から切られたり口を変えられたりする。#288）
        const summarizer = this.summarizer
        const model = this.modelValue
        const provider = this.providerValue
        const generation = this.generation
        // 一言は全体で入にしていて、そのセッションで切っていない（persona が null なら切っている。#263）ときだけ。
        // 案は一言とは別に入切する（#560）。セッションの「作らない」は一言だけを止め、案は作る
        // **人に判断・回答を求めている返答は一言にしない**（#638。本文を読まないと答えられないので、そのまま出す。LLM は呼ばない判定）
        const asking = this.summaryOn && persona !== null && needsFullText(row.text ?? '')
        const wantSummary = this.summaryOn && persona !== null && !asking
        // 案だけ作ってある行（#560）を一言のために積み直したときは、案はもう作らない（案を作るのは 1 ターン 1 回まで。その 1 回の中で、確かめに落ちたら 1 度だけ作り直す。#729）
        const prev = this.store.get(key)
        const wantAsk = this.askOn && this.isLatest(row) && !prev
        if (!summarizer || (!wantSummary && !wantAsk)) {
          // 作らなかったことを残す（3 秒ごとの scan() が同じ行を積み直して判定し直さない。集計で数えられる。#638）。
          // 案だけ作ってあった行は、案を持ち越す
          if (asking && !prev?.skipped) {
            await this.store.append({ key, persona: persona ?? DEFAULT_PERSONA, summary: '', model, ts: new Date().toISOString(), skipped: 'asking', ...(prev?.next_ask ? { next_ask: prev.next_ask, ...(prev.next_ask_source ? { next_ask_source: prev.next_ask_source } : {}) } : {}), ...(prev?.next_ask_retried ? { next_ask_retried: true as const } : {}), ...(prev?.next_ask_dropped ? { next_ask_dropped: prev.next_ask_dropped } : {}) })
          }
          this.queued.delete(key)
          continue
        }
        try {
          // 人が頼んだこと（#376）。返答だけを渡すと、`12` のような短い返答で作例を書き写していた
          const ask = row.user_text ?? ''
          // 規則（#638）が当てなかった返答は、一言を作る前に同じ口に「要約で足りるか」を聞く（#639）。
          // **手元の口（openai）のときだけ**（claude は呼び出しが 1 回増えるぶん時間とトークンが掛かる）。
          // 失敗して作り直す行では聞かない（口が重いときに 1 行で 2 回待たない）
          const judge = wantSummary && provider === 'openai' && !this.failed.has(key) ? await this.judgeFullText(row, summarizer, key) : undefined
          const skipped = asking ? ('asking' as const) : judge === 'full' ? ('judged' as const) : undefined
          const makeSummary = wantSummary && !skipped
          // 一言は 2 つで組む（#713）: 「人が次にすること」は本文の文そのまま、口には「何が起きたか」だけを書かせる。
          // そのまま抜ける文が無い本文（頼みの形でない言い方・質問）は、今までどおり 1 回で全部を書かせる
          const plan = digestPlan(row.text)
          const next = plan.kind === 'two' ? plan.next : ''
          const promptOf = (retry?: DigestRetry) =>
            plan.kind === 'full' ? digestPrompt(persona ?? undefined, row.text, { ask, ...(retry ? { retry } : {}) }) : digestWhatPrompt(persona ?? undefined, row.text, { ask, ...(retry ? { retry } : {}) })
          // 長さの枠は欄ごと（「人が次にすること」は本文の文なので、繋いだ長さでは咎めない）
          const issuesOf = (what: string, whole: string) =>
            digestIssues(row.text, whole, ask).filter((i) => !(i.code === 'too_long' && next && [...what].length <= DIGEST_MAX_CHARS))
          let what = makeSummary && persona !== null ? cleanWhat(plan, await summarizer.summarize(promptOf())) : ''
          const summary = makeSummary ? joinDigest(what, next) : ''
          // 出来上がりを機械で確かめ、駄目なら **1 回だけ** 作り直す（#346。LLM は呼ばない判定）。
          // 2 回目でも残ったら、そのまま出して digest.log に残す（一言が消えるより、残って数えられる方がよい）
          const first = makeSummary ? issuesOf(what, summary) : []
          let best = summary
          let issues = first
          if (first.length > 0 && persona !== null) {
            try {
              const againWhat = cleanWhat(plan, await summarizer.summarize(promptOf({ summary: what, issues: first })))
              const again = joinDigest(againWhat, next)
              const left = issuesOf(againWhat, again)
              // 減ったときだけ採る（作り直しで別の問題が増えることがある）
              if (left.length < first.length) {
                best = again
                what = againWhat
                issues = left
              }
            } catch (err) {
              await this.log(`${new Date().toISOString()} ${key} 作り直しに失敗: ${err instanceof Error ? err.message : String(err)}`)
            }
            const before = first.map((i) => i.code).join(',')
            await this.log(`${new Date().toISOString()} ${key} 作り直し ${before} → ${issues.map((i) => i.code).join(',') || 'ok'}`)
          }
          // 次に送る文面の案（#371）。**そのセッションの一番新しい行のときだけ**作る
          // （pump は増えた行を全部処理するが、古い行の案は作った瞬間に捨てられる）。
          // 一言とは別の呼び出しにしてあるので、ここで失敗しても一言は残る
          // 作っている間に画面から切られたら、案の口は叩かない（作りかけの一言だけ終わらせる。#288 と同じ扱い）
          // **材料は要約する前の本文と人が送った文**（#560。一言を材料にすると、要約で落ちた質問・選択肢・番号に答えられない）。
          // 一言を作らない行では案が唯一の仕事なので、失敗は一言と同じく数える（下の catch。口が落ちている間に同じ行を叩き続けない）
          const freshAsk = wantAsk && this.askOn && this.active && this.isLatest(row)
          const composed: ComposedNextAsk = !freshAsk
            ? { next_ask: prev?.next_ask ?? '', first: [], dropped: [] }
            : wantSummary || asking
              ? // 人に聞いている返答（#638）も、案の失敗は一言の側と同じく飲み込む（作らなかった印は残す。口を休ませる数えに入れない）
                await this.makeNextAsk(row, summarizer, key)
              : await this.nextAskOf(row, summarizer)
          const nextAsk = composed.next_ask
          if (composed.first.length > 0) {
            await this.log(`${new Date().toISOString()} ${key} 案の作り直し ${composed.first.join(',')} → ${composed.dropped.length > 0 ? `${composed.dropped.join(',')}（出さない）` : 'ok'}`)
          }
          await this.store.append({
            key,
            persona: persona ?? DEFAULT_PERSONA,
            summary: best,
            // 2 つで組んだ回は、分けたものも残す（#713。画面が場所ごとに出し分けるときに使う。`summary` は 2 つを繋いだもの）
            ...(best && next ? { what, next } : {}),
            model,
            ts: new Date().toISOString(),
            ...(first.length > 0 ? { retried: true } : {}),
            ...(issues.length > 0 ? { issues: issues.map((i) => i.code) } : {}),
            ...(nextAsk ? { next_ask: nextAsk } : {}),
            // 作り直した・出さなかったの印。積み直した行（案はもう作ってある）では前の行から持ち越す
            // （鍵ごとに最新の行を数えるので、落とすと「わざと出さなかった」が「作れなかった」に数えられる。#736 のレビュー）
            ...((freshAsk ? composed.first.length > 0 : prev?.next_ask_retried) ? { next_ask_retried: true as const } : {}),
            ...(freshAsk ? (composed.dropped.length > 0 ? { next_ask_dropped: composed.dropped } : {}) : prev?.next_ask_dropped ? { next_ask_dropped: prev.next_ask_dropped } : {}),
            // 新しく作った案が本文の引用そのものなら印を付ける。前の行から持ち越した案は、印もそのまま持ち越す
            // （鍵ごとに最新の行を数えるので、落とすと引用から採った案が「口で作った」側に数えられる）
            ...(freshAsk
              ? nextAsk && nextAsk === quotedNextAsk(row.text ?? '') ? { next_ask_source: 'quote' as const } : {}
              : nextAsk && prev?.next_ask_source ? { next_ask_source: prev.next_ask_source } : {}),
            ...(skipped ? { skipped } : {}),
            ...(judge ? { judge } : {}),
          })
          if (generation === this.generation) {
            this.failed.delete(key)
            this.failStreak.clear()
            this.lastFailure = ''
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          await this.log(`${new Date().toISOString()} ${key} ${message}`)
          // 作っている間に口を変えられたら、前の口の失敗は数えない（新しい口がいきなり 1 回失敗した扱いになる）
          if (generation !== this.generation) continue
          // 間を置いて作り直す。DIGEST_MAX_TRIES 回で諦める（#443）
          const count = (this.failed.get(key)?.count ?? 0) + 1
          const delay = DIGEST_RETRY_DELAYS_MS[count - 1]
          this.failed.set(key, { count, next: this.now() + (delay ?? 0) })
          if (count >= DIGEST_MAX_TRIES) await this.log(`${new Date().toISOString()} ${key} ${count} 回失敗したので諦めた`)
          this.failStreak.add(key)
          this.lastFailure = message.slice(0, 120)
          // 続けて落ちたら口ごと休ませる（#497）。休み明けの 1 件も落ちれば、数えはそのままなのでまた休む
          if (this.failStreak.size >= DIGEST_ALERT_FAILS) {
            this.breakUntil = this.now() + DIGEST_BREAK_MS
            await this.log(`${new Date().toISOString()} 続けて ${this.failStreak.size} 件失敗したので ${DIGEST_BREAK_MS / 60_000} 分休む`)
          }
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
      return new OpenAISummarizer(url, model, { apiKey: env.SAI_DIGEST_API_KEY || undefined, log })
    }
    log(`digest: claude model=${model}`)
    return new ClaudeSummarizer(model, feedDir, env, { onFallback: (reason) => log(`digest: claude の軽い形が通らなかったので、前の形で起こします（${reason}）`) })
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
