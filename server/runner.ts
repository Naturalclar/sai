// 返信の実行。セッションを非対話モードの CLI で再開して1ターン回す。
//
// 投げっぱなし（detached + unref）。ターンは数分かかりうるので HTTP を待たせない。
// 回したターンが完了すれば既存のフック（Stop / notify）が動いて JSONL に1行増えるので、
// 結果は今のポーリングで画面に流れてくる。返信専用の記録経路は作らない。
import { spawn } from 'node:child_process'
import { closeSync, openSync, writeSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent, Replying, ReplyingMap } from '../shared/types.ts'

/** `--permission-prompt-tool` に渡す名前。`mcp__<サーバ名>__<ツール名>` で、サーバ名は --mcp-config のキー */
export const APPROVE_TOOL = 'mcp__sai__approve'
export const APPROVE_MCP_PATH = resolvePath(dirname(fileURLToPath(import.meta.url)), 'approve-mcp.ts')

/** 返信中の許可・質問を SAI の画面で答えるための配線。無ければ付けない（非対話のまま。未許可のツールは拒否される） */
export interface ApproveVia {
  /** SAI サーバ（http://127.0.0.1:8787）。MCP の子プロセスがここに預ける */
  url: string
  /** 返信先のエンティティID */
  entity: string
}

/** `--mcp-config` に渡す JSON 文字列。子は node で approve-mcp.ts を直接実行する（サーバ本体と同じ型剥がし） */
export function approveMcpConfig(via: ApproveVia, execPath: string = process.execPath, mcpPath: string = APPROVE_MCP_PATH): string {
  return JSON.stringify({
    mcpServers: {
      sai: {
        type: 'stdio',
        command: execPath,
        args: ['--disable-warning=ExperimentalWarning', mcpPath],
        env: { SAI_URL: via.url, SAI_ENTITY: via.entity },
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
}

/**
 * エージェントごとの再開コマンド。`claude` / `codex` が PATH に無い環境（launchd など）向けに
 * SAI_CLAUDE_BIN / SAI_CODEX_BIN で実行ファイルを差し替えられる。
 */
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
): ReplyCommand | null {
  // 運用者の SAI_*_ARGS に --model があっても、セッションの設定を後ろに置いてそちらを勝たせる（後勝ち）
  const pick = model ? (agent === 'codex' ? ['-m', model] : ['--model', model]) : []
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
    return { bin: env.SAI_CLAUDE_BIN || 'claude', args: [...extra, ...wire, ...pick, '-p', '--resume', session, '--', text], cwd, text }
  }
  if (agent === 'codex') {
    return { bin: env.SAI_CODEX_BIN || 'codex', args: ['exec', 'resume', ...splitArgs(env.SAI_CODEX_ARGS), ...pick, session, '--', text], cwd, text }
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

/** node:child_process で実際に起動する。テストは FakeRunner に差し替える */
export class ProcessRunner implements Runner {
  private active = new Map<string, Replying>()
  readonly logPath: string | null

  /** logPath があれば子プロセスの stdout/stderr を追記する（うまく動かないときの手がかり） */
  constructor(logPath: string | null) {
    this.logPath = logPath
  }

  running(id: string): boolean {
    return this.active.has(id)
  }

  snapshot(): ReplyingMap {
    return Object.fromEntries(this.active)
  }

  async start(id: string, cmd: ReplyCommand, onExit?: () => void): Promise<void> {
    let fd: number | null = null
    if (this.logPath) {
      try {
        fd = openSync(this.logPath, 'a', 0o600)
        writeSync(fd, `--- ${new Date().toISOString()} ${id} ${cmd.bin} ${JSON.stringify(cmd.args)} (cwd ${cmd.cwd})\n`)
      } catch {
        fd = null
      }
    }
    const child = spawn(cmd.bin, cmd.args, {
      cwd: cmd.cwd,
      detached: true,
      // stdin は閉じておく。`claude -p` はパイプが繋がっていると stdin も読みに行く
      stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
    })
    this.active.set(id, { since: new Date().toISOString(), text: cmd.text })
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.active.delete(id)
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
    child.once('exit', release)
    child.once('error', release)
    child.unref()
  }
}
