// 返信の実行。セッションを非対話モードの CLI で再開して1ターン回す。
//
// 投げっぱなし（detached + unref）。ターンは数分かかりうるので HTTP を待たせない。
// 回したターンが完了すれば既存のフック（Stop / notify）が動いて JSONL に1行増えるので、
// 結果は今のポーリングで画面に流れてくる。返信専用の記録経路は作らない。
import { spawn } from 'node:child_process'
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent, Replying, ReplyFailure, ReplyingMap } from '../../shared/types.ts'

/** 失敗した返信を画面に見せておく時間。ポーリングは3秒なので、これだけあれば拾える */
export const FAILED_TTL_MS = 2 * 60_000
/** reply.log から拾う末尾の長さ */
const TAIL_BYTES = 4096
const TAIL_CHARS = 300
const TAIL_LINES = 3

/**
 * reply.log の offset 以降（= このターンの子プロセスが書いた分）の末尾を数行。
 * 大きく育つファイルなので末尾だけ読む。読めなければ空
 */
export function tailFrom(path: string, offset: number): string {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const { size } = fstatSync(fd)
    const start = Math.max(offset, size - TAIL_BYTES)
    const len = size - start
    if (len <= 0) return ''
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, start)
    const lines = buf
      .toString('utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    const text = lines.slice(-TAIL_LINES).join(' / ')
    return text.length <= TAIL_CHARS ? text : `${text.slice(0, TAIL_CHARS)}…`
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // 閉じ損ねても実害なし
      }
    }
  }
}

/** `--permission-prompt-tool` に渡す名前。`mcp__<サーバ名>__<ツール名>` で、サーバ名は --mcp-config のキー */
export const APPROVE_TOOL = 'mcp__sai__approve'
export const APPROVE_MCP_PATH = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'approvals', 'approve-mcp.ts')

/** 返信中の許可・質問を SAI の画面で答えるための配線。無ければ付けない（非対話のまま。未許可のツールは拒否される） */
export interface ApproveVia {
  /** SAI サーバ（http://127.0.0.1:8787）。MCP の子プロセスがここに預ける */
  url: string
  /** 返信先のエンティティID */
  entity: string
  /**
   * エージェント用の口のトークンを置いたファイル（#310）。渡せば MCP サーバが sai_* のツール（別のセッションに話しかける）を出す。
   * **中身ではなく場所を渡す**（`--mcp-config` は引数なので ps で見える）
   */
  tokenFile?: string
}

/** `--mcp-config` に渡す JSON 文字列。子は node で approve-mcp.ts を直接実行する（サーバ本体と同じ型剥がし） */
export function approveMcpConfig(via: ApproveVia, execPath: string = process.execPath, mcpPath: string = APPROVE_MCP_PATH): string {
  return JSON.stringify({
    mcpServers: {
      sai: {
        type: 'stdio',
        command: execPath,
        args: ['--disable-warning=ExperimentalWarning', mcpPath],
        env: { SAI_URL: via.url, SAI_ENTITY: via.entity, ...(via.tokenFile ? { SAI_TOKEN_FILE: via.tokenFile } : {}) },
      },
    },
  })
}

export interface ReplyCommand {
  bin: string
  args: string[]
  cwd: string
  /** 送った文。args の末尾と同じだが、処理中の表示に使うので別に持つ */
  text: string
  /**
   * セッションの設定から付けた許可モード（Claude だけ。`''` はフラグを付けていない＝CLI の既定）。
   * args にも入っているが、処理中のターンがどのモードで動いているかを画面に出すので別に持つ（#272）
   */
  permissionMode?: string
}

/**
 * 環境変数の文字列をシェル風に argv に割る。空白で区切り、'…' / "…" で囲めば空白を含められる。\ で次の1文字をそのまま。
 * `SAI_CLAUDE_ARGS='--allowedTools "Bash(gh *)"'` → ['--allowedTools', 'Bash(gh *)']
 */
export function splitArgs(raw: string | undefined): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  const s = raw ?? ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i)
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s.charAt(++i)
      else cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s.charAt(++i)
      has = true
    } else if (/\s/.test(c)) {
      if (has) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}

/**
 * 返信で起動するコマンド。非対話モードなので許可ダイアログは出せず、未許可のツールはそのまま拒否される。
 * 運用者が SAI_CLAUDE_ARGS / SAI_CODEX_ARGS で追加の引数（`--allowedTools "Bash(gh *)"` など）を渡せる。
 * SAI 自身は何も付けない（既定は素の `claude -p --resume` / `codex exec resume`）。
 * Claude の追加引数は先頭に置く（`--allowedTools` は可変長。本文は `--` の後ろなので飲まれないが、先頭なら `-p` でも切れる）。
 * Codex は `exec resume [OPTIONS] [SESSION_ID] [PROMPT]` なので `resume` の直後
 */
export function replyCommand(
  agent: Agent,
  session: string,
  text: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  approve?: ApproveVia,
  /** このセッションの返信で使うモデル（session-meta.json の model）。無ければ CLI の既定 */
  model?: string,
  /**
   * このセッションの返信の許可モード（session-meta.json の permission_mode）。無ければ CLI の既定。
   * そのターン限りで、セッションには残らない（確かめた: フラグ付きで回したセッションをフラグ無しで再開すると元に戻る）
   */
  permissionMode?: string,
  /** 添える画像の絶対パス。本文には呼び出し側が足しておく（ここでは Codex の -i だけ組む） */
  attachments: readonly string[] = [],
): ReplyCommand | null {
  // 運用者の SAI_*_ARGS に --model / --permission-mode があっても、セッションの設定を後ろに置いてそちらを勝たせる（後勝ち）
  const pick = model ? (agent === 'claude' ? ['--model', model] : ['-m', model]) : []
  // 許可モードは Claude だけ（codex exec resume に同等のフラグは無い）
  const mode = permissionMode && agent === 'claude' ? ['--permission-mode', permissionMode] : []
  // 本文の前に `--` を置く。本文が `-` で始まると（`-v` や `--help`）CLI がフラグとして解釈して
  // ターンが回らない（`--dangerously-skip-permissions` ならフラグとして効いてしまう）。両 CLI とも `--` を受け付ける
  if (agent === 'claude') {
    const extra = splitArgs(env.SAI_CLAUDE_ARGS)
    // 許可・質問を画面で答える配線（Claude だけ。Codex に同等の口は無い）。
    // SAI_APPROVE=0 で外せる。運用者が自分の --permission-prompt-tool を足していればそちらを尊重する。
    // `--mcp-config` は可変長なので、直後に別のフラグ（--permission-prompt-tool）が来る並びにしておく
    const wire = approve && env.SAI_APPROVE !== '0' && !extra.includes('--permission-prompt-tool')
      ? ['--mcp-config', approveMcpConfig(approve), '--permission-prompt-tool', APPROVE_TOOL]
      : []
    return { bin: 'claude', args: [...extra, ...wire, ...pick, ...mode, '-p', '--resume', session, '--', text], cwd, text, permissionMode: permissionMode || '' }
  }
  if (agent === 'codex') {
    // Codex は画像を受ける口がある（`-i, --image <FILE>  Optional image(s) to attach to the prompt sent after resuming`）
    const images = attachments.flatMap((p) => ['-i', p])
    return { bin: 'codex', args: ['exec', 'resume', ...splitArgs(env.SAI_CODEX_ARGS), ...pick, ...images, session, '--', text], cwd, text }
  }
  if (agent === 'opencode') {
    // `opencode run -s <session> -m <provider/model> -f <file> -- <text>`（1.18.30 で確認）。
    // 画像は `-f/--file`（添付するファイル）。許可・質問を画面で答える口は無いので approve の配線はしない。
    // 非対話でも本体の中でプラグインが動くので、この返信ぶんも普通のターンとして記録される（返信専用の記録経路は無い）
    const files = attachments.flatMap((p) => ['-f', p])
    return { bin: 'opencode', args: ['run', ...splitArgs(env.SAI_OPENCODE_ARGS), ...pick, ...files, '-s', session, '--', text], cwd, text }
  }
  return null
}

export interface Runner {
  /** そのエンティティに対して回している最中か */
  running(id: string): boolean
  /** 処理中の返信を全部。API に載せて画面に伝える */
  snapshot(): ReplyingMap
  /** 起動する。プロセスが立ち上がらなければ（ENOENT など）reject。onExit はプロセスが終わったとき（答え待ちの片付けに使う） */
  start(id: string, cmd: ReplyCommand, onExit?: () => void): Promise<void>
}

/** replying.json の1件。画面に出す Replying に、生存確認用の pid を足したもの。pid 0 は spawn 待ち（自分の子で、まだ pid が無い） */
/**
 * 終了の仕方から「失敗」を作る。0 で終わったなら null（失敗ではない）。
 * シグナルで死んだときはコードが無いので負の値（-15 = SIGTERM）にして区別できるようにする
 */
export function failureOf(code: number | null | undefined, signal: NodeJS.Signals | null | undefined, logPath: string | null, offset: number): ReplyFailure | null {
  if (signal) return { code: -1, tail: `シグナル ${signal} で終了${logPath ? `。${tailFrom(logPath, offset)}` : ''}`.trim() }
  if (code === 0 || code === null || code === undefined) return null
  return { code, tail: logPath ? tailFrom(logPath, offset) : '' }
}

interface Persisted extends Replying {
  pid: number
  /** 非0で終わった時刻（ミリ秒）。FAILED_TTL_MS を過ぎたら捨てる。失敗の分は replying.json に書かない */
  failedAt?: number
}

/**
 * SAI が起動した子に渡す環境。**`TMUX_PANE` を落とす**（#234）。
 *
 * 子は SAI サーバの環境をそのまま継ぐので、そのままだと `pnpm start` を打ったペインの `TMUX_PANE` が
 * 渡り、そこで動く `record.py` が**サーバ自身のペイン**を行に書いてしまう（手元では 6 つの worktree の
 * セッションが全部 1 つのペインに付いていた）。そうなると `SessionSummary.terminal` が偽陽性になり、
 * 「端末で開いているから処理中でも送れる」と誤判定して二重起動の歯止め（#100 / #170）が外れる。
 *
 * 落とすのは `TMUX_PANE` だけで、`TMUX`（サーバのソケット）は残す。エージェントがターンの中で
 * `tmux` を使うことはあるので、tmux ごと見えなくはしない。
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next.TMUX_PANE
  return next
}

/** pid が生きているか。EPERM は「居るが触れない」なので生きている扱い。0 以下（spawn 待ちの自分の子）は生きている扱い */
export function isAlive(pid: number): boolean {
  if (pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * node:child_process で実際に起動する。テストは FakeRunner に差し替える。
 *
 * 「処理中」の正はここだが、メモリだけだとサーバの再起動（pnpm start:watch で server/ が変わった、など）で
 * 忘れる。子は detached なので生き残っているのに、画面の「処理中」が消えて人がもう一度送り、同じセッションに
 * 返信が二重に走った（#100）。生き残った子からの許可の POST も 409 になっていた。
 * そこで statePath（~/.agent-feed/replying.json）にも書き、起動時に読んで生きている pid の分を引き取る。
 * 引き取った分は exit を待てないので、見るたびに kill(pid, 0) で生存を確かめ、死んでいたら落とす。
 */
export class ProcessRunner implements Runner {
  private active = new Map<string, Persisted>()
  readonly logPath: string | null
  readonly statePath: string | null

  /** logPath があれば子プロセスの stdout/stderr を追記する（うまく動かないときの手がかり）。statePath があれば処理中をそこにも持つ */
  constructor(logPath: string | null, statePath: string | null = null) {
    this.logPath = logPath
    this.statePath = statePath
    this.adopt()
  }

  /** 前のサーバが残した replying.json を読み、まだ生きている pid の分だけ引き取る。壊れていれば無視 */
  private adopt(): void {
    if (!this.statePath) return
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.statePath, 'utf-8'))
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const { pid, since, text, permission_mode } = value as Partial<Persisted>
      if (typeof pid !== 'number' || pid <= 0 || typeof since !== 'string' || typeof text !== 'string') continue
      // 許可モードはこの項目より前のサーバが書いた分には無い。無ければ「分からない」のまま（画面は何も出さない。#272）
      if (isAlive(pid)) this.active.set(id, { pid, since, text, ...(typeof permission_mode === 'string' ? { permission_mode } : {}) })
    }
    this.persist() // 死んでいた分を落とした形で書き直す
  }

  /** いまの active を書く。tmp → rename（session-meta.json と同じ）。書けなくても返信は止めない */
  private persist(): void {
    if (!this.statePath) return
    try {
      mkdirSync(dirname(this.statePath), { recursive: true })
      const tmp = `${this.statePath}.${process.pid}.tmp`
      const alive = [...this.active].filter(([, r]) => r.failedAt === undefined)
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(alive), null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.statePath)
    } catch {
      // 書けなくても処理中の判定はメモリで続く
    }
  }

  /** 引き取った分（exit を受け取れない）が死んでいたら落とす。自分の子は exit で消えるが、ここで消えても同じ */
  private sweep(): void {
    let changed = false
    const now = Date.now()
    for (const [id, r] of this.active) {
      // 失敗した分は pid が死んでいても、画面が拾えるまで少し残す
      if (r.failedAt !== undefined) {
        if (now - r.failedAt > FAILED_TTL_MS) this.active.delete(id)
        continue
      }
      if (!isAlive(r.pid)) {
        this.active.delete(id)
        changed = true
      }
    }
    if (changed) this.persist()
  }

  /** 処理中か。失敗して残しているだけの分は「処理中ではない」（次の返信を止めない） */
  running(id: string): boolean {
    this.sweep()
    return this.active.get(id)?.failedAt === undefined && this.active.has(id)
  }

  snapshot(): ReplyingMap {
    this.sweep()
    // pid と failedAt は画面に要らない
    return Object.fromEntries(
      [...this.active].map(([id, { since, text, permission_mode, failed }]) => [
        id,
        { since, text, ...(permission_mode !== undefined ? { permission_mode } : {}), ...(failed ? { failed } : {}) },
      ]),
    )
  }

  async start(id: string, cmd: ReplyCommand, onExit?: () => void): Promise<void> {
    let fd: number | null = null
    // 子が書き始める位置。非0で終わったとき、ここから末尾を読んで理由にする（#172）
    let logOffset = 0
    if (this.logPath) {
      try {
        fd = openSync(this.logPath, 'a', 0o600)
        writeSync(fd, `--- ${new Date().toISOString()} ${id} ${cmd.bin} ${JSON.stringify(cmd.args)} (cwd ${cmd.cwd})\n`)
        logOffset = fstatSync(fd).size
      } catch {
        fd = null
      }
    }
    const child = spawn(cmd.bin, cmd.args, {
      cwd: cmd.cwd,
      detached: true,
      // SAI が起動した子は「端末で開いている」ではない。サーバのペインを継がせない（#234）
      env: childEnv(),
      // stdin は閉じておく。`claude -p` はパイプが繋がっていると stdin も読みに行く
      stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
    })
    // spawn を待つ前から「処理中」にする（同じセッションへの2つ目をこの隙に通さない）。pid は spawn したら入れる
    // 起動したときの許可モードも覚える。動いている CLI には後から当てられないので、画面が今の設定と比べる（#272）
    const entry: Persisted = { pid: 0, since: new Date().toISOString(), text: cmd.text, ...(cmd.permissionMode !== undefined ? { permission_mode: cmd.permissionMode } : {}) }
    this.active.set(id, entry)
    let released = false
    /**
     * プロセスが終わった。非0（かシグナル）なら、画面が理由を出せるように少し残す。
     * 0 なら今までどおり消す（記録が増えたかは画面が行数で見る）
     */
    const release = (code?: number | null, signal?: NodeJS.Signals | null) => {
      if (released) return
      released = true
      const failure = failureOf(code, signal, this.logPath, logOffset)
      if (failure) {
        this.active.set(id, { ...entry, failed: failure, failedAt: Date.now() })
      } else {
        this.active.delete(id)
      }
      this.persist()
      onExit?.()
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // 閉じ損ねても実害なし
        }
        fd = null
      }
    }
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
    } catch (err) {
      release()
      throw err
    }
    entry.pid = child.pid ?? 0
    this.persist()
    child.once('exit', (code, signal) => release(code, signal))
    // spawn した後の error（EPIPE など）。終了コードは分からないので失敗としては残さない
    child.once('error', () => release())
    child.unref()
  }
}
