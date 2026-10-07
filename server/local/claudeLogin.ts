// Claude のログインが切れたとき、SAI から `claude auth login` の手順を踏む（#577 の後半）。
//
// 切れると SAI が起こす `claude` の仕事が全部失敗し、直すには Mac の端末で打つしかなかった（携帯から tailnet 越しに見ていると、
// Mac の前に戻るまで何もできない）。`claude auth login` は TTY が無くても、ログイン用の URL を stdout に出し、
// 貼ったコードを stdin で受ける（2.1.292 で実測。#577 のコメント）ので、子として起こして画面と取り次ぐ。
//
// 決まり:
//
// - **SAI は鍵を持たない。** URL はメモリに持つだけ（子が終われば捨てる）、コードは子の stdin に渡すだけで変数にも残さない。
//   どちらもファイル・`reply.log`・記録に書かない。ログ（`claude-login.log`）に残すのは終了コード・時間・行数だけ
// - 起こすのは `claude auth login` の 1 形だけ。`logout` / `setup-token` は起こさない
// - **子は 1 本だけ**で、時間切れで落とす（子は自分では終わらない。stdin を閉じても待ち続ける）
// - **Mac のブラウザは開かせない**（tailnet 越しに携帯から押すことがある）。子は PATH の `open` で開こうとするので、
//   **この子にだけ** PATH の先頭に何もしない `open` を置く（「実行ファイルは PATH から探す・差し替えない」の例外はここだけ）。
//   置き場は**起こすたびに作る 0700 のディレクトリ**で、子が終われば消す（前から置いてあるファイルを PATH に載せない・
//   仕込まれたシンボリックリンクを辿って書かない）
// - 画面に出す URL は Anthropic のホストのものだけ（子が先に別の URL を出しても、それをログインのリンクにしない）
// - **切れていると分かっているときだけ起こす**（起こす前に `claude auth status` を聞き直す。ログインできている・分からないなら起こさない）
// - 終わったら `claude auth status` を聞き直す（「できた」は終了コードではなくこれで決める）
// - 本物を起こすのは `main.ts` だけ。`createApp` の既定（`NoClaudeLogin`）は何も起こさない
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { rmSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { CLAUDE_LOGIN_TIMEOUT_MS } from '../../shared/claudeLogin.ts'
import type { ClaudeLoginResponse } from '../../shared/types.ts'
import { childEnv } from '../reply/runner.ts'

/** 人がブラウザでログインしてコードを貼るまで待つ長さ。過ぎたら子を落とす */
export const LOGIN_TIMEOUT_MS = CLAUDE_LOGIN_TIMEOUT_MS
/** 貼るコードの上限（実物は 100 字前後。長い文を子に流し込ませない） */
export const LOGIN_CODE_MAX = 2048
/** 子の出力を持つ上限（URL を探すだけ。垂れ流されても溜め込まない） */
const OUTPUT_MAX = 65536
/** URL が出るのを待つ長さ（実測は 0.1 秒）。過ぎても出なければ諦める */
export const LOGIN_URL_WAIT_MS = 20_000
export const LOGIN_LOG_FILE = 'claude-login.log'
/**
 * コードを渡したあと、子が終わらないままログインできていないかを聞き直す間合い（渡してからの秒）。
 * 正しいコードを渡したあと子が自分で終わるかは実物で確かめていない（#577）。終わらない版でも、時間切れまで「確かめています」で止めない
 */
export const LOGIN_SENT_RECHECK_MS = [5_000, 15_000, 40_000]
/** これより古い `open` の置き場は前の回の残りとして消す（同じ置き場を使う別のサーバの、走っている回のものは消さない） */
const SHIM_STALE_MS = 60 * 60_000
/** SIGTERM で終わらない子を SIGKILL するまで（終わらないと、次のログインがずっと始められない） */
export const LOGIN_KILL_GRACE_MS = 3000
/** 出力がこれだけ止まったら、末尾に区切りの無い URL も取る */
export const LOGIN_URL_SETTLE_MS = 700
/** PATH が空のときに子へ渡す PATH（末尾が空の PATH は、子の作業ディレクトリを PATH に載せてしまう） */
const FALLBACK_PATH = '/usr/bin:/bin'
/** ログイン用の URL として出してよいホスト（2.1.292 は `claude.com`。同じ持ち主のドメインだけ） */
const LOGIN_HOSTS = ['claude.com', 'claude.ai', 'anthropic.com']
const loginHost = (host: string) => LOGIN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))

/** ログインの手順を踏む口。テストとスクラッチのサーバは差し替える */
export interface ClaudeLoginRunner {
  state(): ClaudeLoginResponse
  /** 子を起こす。もう走っていれば起こさず、いまの状態を返す */
  start(): ClaudeLoginResponse
  /** 貼ったコードを子に渡す。渡せたら true（待っている子が居ない・形が変なら false） */
  code(code: string): boolean
  /** 子を落として最初に戻す */
  cancel(): ClaudeLoginResponse
  /** サーバが終わるとき。子を残さない */
  stop(): void
}

/** 起こさない実装（`createApp` の既定。テストとスクラッチのサーバが本物の `claude auth login` を起こさない） */
export class NoClaudeLogin implements ClaudeLoginRunner {
  state(): ClaudeLoginResponse {
    return { status: 'idle' }
  }
  start(): ClaudeLoginResponse {
    return { status: 'failed', note: 'unavailable' }
  }
  code(): boolean {
    return false
  }
  cancel(): ClaudeLoginResponse {
    return { status: 'idle' }
  }
  stop(): void {}
}

// 端末のリンクの印（OSC 8）と色の印。URL はこの印で包まれて 2 回出る
// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[A-Za-z]/g

/**
 * 子の stdout からログイン用の URL を取る。**https・Anthropic のホスト・戻り先（`redirect_uri`）があって `localhost` でないもの**
 * （携帯で開いてコードを表示する方）だけ。**後ろに区切りが来ているもの**だけを取る（出力の切れ目で途中までの URL を出さない）。
 * 出力が止まったあと（`settled`）は、末尾の URL も取る（URL を出したきり改行せずに入力を待つ版）。
 * 見つからなければ空
 */
export function loginUrl(out: string, settled = false): string {
  // `settled` = 出力が止まった（もう続きは来ない）。末尾の URL も区切りが来たものとして取る
  const plain = `${out.replace(ESCAPES, ' ')}${settled ? ' ' : ''}`
  for (const m of plain.matchAll(/https:\/\/[^\s"'<>]+(?=[\s"'<>])/g)) {
    let url: URL
    try {
      url = new URL(m[0])
    } catch {
      continue
    }
    if (url.protocol !== 'https:' || url.username || url.password || !loginHost(url.hostname)) continue
    // 認可の URL だけ（案内のリンクのような、戻り先の無い URL はログインのリンクにしない）
    const back = url.searchParams.get('redirect_uri') ?? ''
    if (!back) continue
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(back)) continue
    return url.href
  }
  return ''
}

/**
 * 貼ったコードとして子に渡してよい形か。**空白を含まない ASCII の印字できる字だけ**・長すぎない（1 回の POST で子に
 * 2 行ぶん渡させない。U+2028 のような行の区切りも通さない）。前後の空白は落とす
 */
export function loginCode(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const code = raw.trim()
  if (!code || code.length > LOGIN_CODE_MAX || !/^[\x21-\x7e]+$/.test(code)) return ''
  return code
}

/** 子が「コードが違う」と言ったか（2.1.292 の文言。出なくても `sent` のままコードは渡し直せる。画面も送るボタンを止めない） */
const INVALID_CODE = /invalid code/i

export interface ClaudeLoginDeps {
  /** 実行ファイル。既定はサーバの PATH の `claude`（#288） */
  bin?: string
  /** 何もしない `open` を置くディレクトリを作る場所（この下に、起こすたびに 0700 のディレクトリを作って子の PATH の先頭に足す） */
  shimDir: string
  /** ログの置き場（`claude-login.log`）。渡さなければ残さない */
  logDir?: string
  /** ログインの状態を聞き直す（起こす前と、子が終わったあと）。前の結果は使わない。分からなければ `undefined` */
  recheck: () => Promise<{ loggedIn: boolean } | undefined>
  timeoutMs?: number
  urlWaitMs?: number
  killGraceMs?: number
  sentRecheckMs?: readonly number[]
  now?: () => number
}

interface Running {
  child: ChildProcessWithoutNullStreams
  since: number
  out: string
  stdoutBytes: number
  stderrBytes: number
  stdoutLines: number
  stderrLines: number
  codes: number
  invalid: number
  /** コードを渡したあとに出た分だけを見る位置 */
  mark: number
  endedBy: 'exit' | 'timeout' | 'cancel' | 'no_url' | 'shutdown' | 'logged_in'
  /** SAI が落とした（やめた・時間切れ）。落としたあとの出力や時間切れは、もう状態に触らない */
  dropped: boolean
  /** この子のために作った `open` の置き場（終わったら消す） */
  shim: string
  timer: ReturnType<typeof setTimeout>
  urlTimer: ReturnType<typeof setTimeout>
  /** コードを渡したあとの聞き直しの予定 */
  sentTimers: ReturnType<typeof setTimeout>[]
  /** 出力が止まるのを待つ（末尾の URL を取る） */
  settleTimer?: ReturnType<typeof setTimeout>
}

/**
 * 子にシグナルを送る。子は自分のプロセスグループで起こしてある（`detached`）ので、**グループごと**送る
 * （`claude` が包みのスクリプトでも、本体の `auth login` を残さない）。グループに送れなければ子だけに送る
 */
function signalGroup(child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, sig)
    else child.kill(sig)
  } catch {
    try {
      child.kill(sig)
    } catch {
      // もう居ない
    }
  }
}

const SHIM = '#!/bin/sh\n# SAI がログインの子にだけ見せる、何もしない open（#577。Mac のブラウザを開かせない）\nexit 0\n'
/** 出力を持ち過ぎたら残す末尾の長さ（「コードが違う」を探すのに足りる分） */
const OUTPUT_TAIL = 8192

/**
 * 状態を持つのは「いまの子」（`running`）だけ。SAI が落とした子は `running` から外して `dying` に移し、
 * その出力・時間切れ・終了は画面の状態に触らない（落とした子の URL を、次の子のものとして出さない）。
 * 次の子は、前の子が全部終わってから起こす（同時に生きているのは 1 本）
 */
export class ClaudeLogin implements ClaudeLoginRunner {
  private readonly bin: string
  private readonly shimDir: string
  private readonly logDir: string | undefined
  private readonly recheck: ClaudeLoginDeps['recheck']
  private readonly timeoutMs: number
  private readonly urlWaitMs: number
  private readonly killGraceMs: number
  private readonly sentRecheckMs: readonly number[]
  private readonly now: () => number
  private running: Running | null = null
  /** 落としたが、まだ終わっていない子 */
  private readonly dying = new Set<Running>()
  private waiters: (() => void)[] = []
  private current: ClaudeLoginResponse = { status: 'idle' }
  /** やめた・終わるときに進める。始めている途中にやめたら、その回は子を起こさない */
  private generation = 0
  /** 始めている途中の回（`generation` と同じなら、いまの回が進んでいる） */
  private opening: number | null = null
  /** 終わった子の結果を聞き直している回。聞き直しが返ったとき、まだこの回なら状態に書く */
  private settling: Running | null = null
  /** サーバが終わる（`stop()` のあと）。もう子を起こさない（起こすと、落とす者の居ない子が残る） */
  private stopped = false

  constructor(deps: ClaudeLoginDeps) {
    this.bin = deps.bin ?? 'claude'
    this.shimDir = deps.shimDir
    this.logDir = deps.logDir
    this.recheck = deps.recheck
    this.timeoutMs = deps.timeoutMs ?? LOGIN_TIMEOUT_MS
    this.urlWaitMs = deps.urlWaitMs ?? LOGIN_URL_WAIT_MS
    this.killGraceMs = deps.killGraceMs ?? LOGIN_KILL_GRACE_MS
    this.sentRecheckMs = deps.sentRecheckMs ?? LOGIN_SENT_RECHECK_MS
    this.now = deps.now ?? Date.now
  }

  state(): ClaudeLoginResponse {
    return this.current
  }

  /**
   * 始める。もう進んでいれば（始めている途中・子が待っている・結果を聞き直している）何も起こさず、いまの状態を返す
   * （別のタブ・開き直した画面は、同じ子の続きに乗る）
   */
  start(): ClaudeLoginResponse {
    if (this.stopped) return { status: 'failed', note: 'unavailable' }
    if (this.running || this.settling || this.opening === this.generation) return this.current
    this.current = { status: 'starting' }
    this.opening = this.generation
    void this.open(this.generation)
    return this.current
  }

  code(raw: string): boolean {
    const run = this.running
    const code = loginCode(raw)
    if (!run || !code || (this.current.status !== 'waiting' && this.current.status !== 'sent')) return false
    // 子がもう入力を閉じていれば渡せない（書き込みの失敗はあとから来るので、先に見る）
    if (!run.child.stdin.writable) return false
    try {
      run.child.stdin.write(`${code}\n`)
    } catch {
      return false
    }
    run.codes++
    run.mark = run.out.length
    this.current = { status: 'sent', ...(this.current.url ? { url: this.current.url } : {}) }
    // 子が終わらないままログインできている版に備えて、少し置いて聞き直す
    for (const timer of run.sentTimers.splice(0)) clearTimeout(timer)
    for (const ms of this.sentRecheckMs) run.sentTimers.push(setTimeout(() => void this.peekAfterCode(run), ms))
    return true
  }

  /**
   * コードを渡したあと、子がまだ生きている間の聞き直し。**ログインできていたら**、子を落として `done` にする
   * （できていなければ何もしない。待ちは続く）
   */
  private async peekAfterCode(run: Running): Promise<void> {
    if (this.running !== run) return
    let loggedIn: boolean | undefined
    try {
      loggedIn = (await this.recheck())?.loggedIn
    } catch {
      loggedIn = undefined
    }
    if (loggedIn !== true || this.running !== run) return
    this.drop(run, 'logged_in')
  }

  cancel(): ClaudeLoginResponse {
    this.generation++
    if (this.running) this.drop(this.running, 'cancel')
    // 結果を聞き直している途中でも最初に戻す（その回の結果は捨てる。次の「始める」に前の回の結果を見せない）
    this.settling = null
    this.current = { status: 'idle' }
    return this.current
  }

  /**
   * サーバが終わるとき。このあとすぐプロセスが終わる（子の終了も、SIGKILL までの待ちも来ない）ので、
   * **待たずに SIGKILL し、置き場もその場で消す**（人の居ない子と `open` の置き場を残さない）
   */
  stop(): void {
    this.stopped = true
    this.generation++
    const runs = [...this.dying, ...(this.running ? [this.running] : [])]
    // 止めたあとも応答する間（終わるのを待っている）に、「確かめています」のまま残さない
    this.running = null
    this.settling = null
    this.current = { status: 'idle' }
    for (const run of runs) {
      if (!run.dropped) run.endedBy = 'shutdown'
      run.dropped = true
      clearTimeout(run.timer)
      clearTimeout(run.urlTimer)
      clearTimeout(run.settleTimer)
      for (const timer of run.sentTimers.splice(0)) clearTimeout(timer)
      signalGroup(run.child, 'SIGKILL')
      try {
        rmSync(run.shim, { recursive: true, force: true })
      } catch {
        // 消せなくても終わる
      }
    }
  }

  /**
   * 子を落として「いまの子」から外す。SIGTERM で終わらなければ SIGKILL（自分の子だけ。終わらないと次が始められない）。
   * 時間切れ・URL が出ないときは、このあと聞き直して結果を出す（`settling`）
   */
  private drop(run: Running, by: 'cancel' | 'timeout' | 'no_url' | 'logged_in'): void {
    if (run.dropped) return
    run.dropped = true
    run.endedBy = by
    clearTimeout(run.timer)
    clearTimeout(run.urlTimer)
    clearTimeout(run.settleTimer)
    for (const timer of run.sentTimers.splice(0)) clearTimeout(timer)
    if (this.running === run) this.running = null
    this.dying.add(run)
    if (by !== 'cancel') {
      this.settling = run
      this.current = { status: 'checking' }
    }
    signalGroup(run.child, 'SIGTERM')
    const timer = setTimeout(() => {
      // 終わったあとには送らない（終わった子の番号が、別のプロセスに使い回されているかもしれない）
      if (run.child.exitCode === null && run.child.signalCode === null) signalGroup(run.child, 'SIGKILL')
    }, this.killGraceMs)
    timer.unref()
    run.child.once('exit', () => clearTimeout(timer))
  }

  /** 落とした子が全部終わるまで待つ（同時に生きているのは 1 本） */
  private drained(): Promise<void> {
    return this.dying.size === 0 ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve))
  }

  private async open(generation: number): Promise<void> {
    const stale = () => generation !== this.generation
    let shim = ''
    try {
      await this.drained()
      if (stale()) return
      // **切れていると分かっているときだけ**起こす。ログインできている・分からないときに起こすと、いまのログイン
      // （動いている全セッション）を差し替えかねない。数秒前の結果は使わない（`recheck` は聞き直す）
      let loggedIn: boolean | undefined
      try {
        loggedIn = (await this.recheck())?.loggedIn
      } catch {
        loggedIn = undefined
      }
      if (stale()) return
      if (loggedIn !== false) {
        this.current = { status: 'failed', note: loggedIn ? 'logged_in' : 'unknown' }
        return
      }
      // 置き場は毎回新しく作る（mkdtemp は 0700）。前からあるファイル・リンクには書かない（`wx`）
      await mkdir(this.shimDir, { recursive: true, mode: 0o700 })
      // 前にサーバが落ちたときの残りを片付ける。**古いものだけ**（同じ置き場を使う別のサーバの、走っている回のものは消さない）
      for (const name of await readdir(this.shimDir)) {
        if (!/^p-[A-Za-z0-9]+$/.test(name)) continue
        const old = await stat(join(this.shimDir, name)).then((st) => this.now() - st.mtimeMs > SHIM_STALE_MS, () => false)
        if (old) await rm(join(this.shimDir, name), { recursive: true, force: true })
      }
      if (stale() || this.stopped) return
      shim = await mkdtemp(join(this.shimDir, 'p-'))
      for (const name of ['open', 'xdg-open']) await writeFile(join(shim, name), SHIM, { flag: 'wx', mode: 0o755 })
      // 用意している間にやめた・終わった: 起こさない（人の居ない子に URL を持たせない）
      if (stale() || this.stopped) return
      const env = childEnv()
      const child = spawn(this.bin, ['auth', 'login'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { ...env, PATH: `${shim}${delimiter}${env.PATH || FALLBACK_PATH}` } })
      this.watch(child, shim)
      shim = ''
    } catch {
      if (!stale()) this.current = { status: 'failed', note: 'spawn_failed' }
    } finally {
      if (shim) await rm(shim, { recursive: true, force: true }).catch(() => {})
      if (this.opening === generation) this.opening = null
    }
  }

  private watch(child: ChildProcessWithoutNullStreams, shim: string): void {
    const run: Running = {
      child,
      since: this.now(),
      out: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutLines: 0,
      stderrLines: 0,
      codes: 0,
      invalid: 0,
      mark: 0,
      endedBy: 'exit',
      dropped: false,
      shim,
      timer: setTimeout(() => this.drop(run, 'timeout'), this.timeoutMs),
      urlTimer: setTimeout(() => {
        if (this.running === run && this.current.status === 'starting') this.drop(run, 'no_url')
      }, this.urlWaitMs),
      sentTimers: [],
    }
    this.running = run
    const lines = (s: string) => s.split('\n').length - 1
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      run.stdoutBytes += Buffer.byteLength(chunk)
      run.stdoutLines += lines(chunk)
      // 落とした子の出力は状態に触らない
      if (this.running !== run) return
      run.out += chunk
      if (run.out.length > OUTPUT_MAX) {
        const cut = run.out.length - OUTPUT_TAIL
        run.out = run.out.slice(cut)
        run.mark = Math.max(0, run.mark - cut)
      }
      if (this.current.status === 'starting') {
        const url = loginUrl(run.out)
        if (url) this.current = { status: 'waiting', url }
        else {
          // 続きが来なければ、末尾の URL を取る
          clearTimeout(run.settleTimer)
          run.settleTimer = setTimeout(() => {
            if (this.running !== run || this.current.status !== 'starting') return
            const last = loginUrl(run.out, true)
            if (last) this.current = { status: 'waiting', url: last }
          }, LOGIN_URL_SETTLE_MS)
        }
      } else if (this.current.status === 'sent' && INVALID_CODE.test(run.out.slice(run.mark))) {
        run.invalid++
        run.mark = run.out.length
        this.current = { status: 'waiting', note: 'invalid_code', ...(this.current.url ? { url: this.current.url } : {}) }
      }
    })
    child.stderr.on('data', (chunk: string) => {
      run.stderrBytes += Buffer.byteLength(chunk)
      run.stderrLines += lines(chunk)
    })
    // 子が先に閉じた stdin へ書いても落ちない
    child.stdin.on('error', () => {})
    let ended = false
    const end = (code: number | null, signal: NodeJS.Signals | null, spawnFailed = false) => {
      if (ended) return
      ended = true
      clearTimeout(run.timer)
      clearTimeout(run.urlTimer)
      clearTimeout(run.settleTimer)
      for (const timer of run.sentTimers.splice(0)) clearTimeout(timer)
      // 子が終わった瞬間に、グループに残った孫（`claude` が包みのスクリプトのときの本体）を落とす。
      // あとからは送らない（終わった子の番号が使い回されるかもしれない）
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // 残っていない
        }
      }
      void rm(run.shim, { recursive: true, force: true }).catch(() => {})
      this.dying.delete(run)
      if (this.running === run) {
        // 自分で終わった（コードが通った・落ちた）: 結果を聞き直す
        this.running = null
        this.settling = run
        this.current = { status: 'checking' }
      }
      if (this.dying.size === 0) for (const wake of this.waiters.splice(0)) wake()
      void this.finish(run, code, signal, spawnFailed)
    }
    // `error` は起こせなかったとき（pid が無い）だけ終わりとして扱う。生きている子への kill や書き込みの失敗でも
    // `error` は来るので、それで「終わった」ことにすると、時間切れの無い子が残り 2 本目を起こせてしまう
    child.on('error', () => {
      if (child.pid === undefined) end(null, null, true)
    })
    // `close`（出力の口が全部閉じた）ではなく `exit` で見る。`claude` が包みのスクリプトで、孫が口を持ったままでも終わりにできる
    child.on('exit', (code, signal) => end(code, signal))
  }

  /** 子が終わったあと。ログインの状態を聞き直して結果を出し（やめた子は出さない）、起きたこと（中身は除く）をログに残す */
  private async finish(run: Running, code: number | null, signal: NodeJS.Signals | null, spawnFailed: boolean): Promise<void> {
    const by = run.endedBy
    // やめた・サーバが終わるときは聞き直さない（画面はもう最初に戻っている）
    if (by === 'cancel' || by === 'shutdown') {
      await this.log(run, code, signal, undefined)
      return
    }
    let loggedIn: boolean | undefined
    if (by === 'logged_in') loggedIn = true
    else {
      try {
        loggedIn = (await this.recheck())?.loggedIn
      } catch {
        loggedIn = undefined
      }
    }
    if (this.settling === run) {
      this.settling = null
      this.current = loggedIn === true ? { status: 'done' } : { status: 'failed', note: spawnFailed ? 'spawn_failed' : by === 'timeout' ? 'timeout' : by === 'no_url' ? 'no_url' : 'exited' }
    }
    await this.log(run, code, signal, loggedIn)
  }

  /**
   * 次に本当に切れたとき、正しいコードを渡したあと何が起きたかを見るための記録（#577。完了までは実物で確かめていない）。
   * **残すのは数だけ**（終了コード・シグナル・かかった時間・出力の行数とバイト数・コードを渡した回数・聞き直した結果）。
   * URL・コード・出力の文言は残さない
   */
  private async log(run: Running, code: number | null, signal: NodeJS.Signals | null, loggedIn: boolean | undefined): Promise<void> {
    if (!this.logDir) return
    const line = {
      ts: new Date(this.now()).toISOString(),
      ended_by: run.endedBy,
      exit_code: code,
      signal,
      duration_ms: this.now() - run.since,
      stdout_lines: run.stdoutLines,
      stdout_bytes: run.stdoutBytes,
      stderr_lines: run.stderrLines,
      stderr_bytes: run.stderrBytes,
      codes_sent: run.codes,
      invalid_codes: run.invalid,
      logged_in_after: loggedIn ?? null,
    }
    try {
      await appendFile(join(this.logDir, LOGIN_LOG_FILE), `${JSON.stringify(line)}\n`, { mode: 0o600 })
    } catch {
      // 残せなくてもログインの結果は変えない
    }
  }
}
