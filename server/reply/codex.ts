import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ReplyCommand } from './runner.ts'
import { childEnv, splitArgs } from './runner.ts'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Codex が thread-store の writer を持っている印。ID を検査して CODEX_HOME の外を読ませない。 */
export function codexWriterLockPath(session: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!SESSION_ID.test(session)) return null
  const raw = env.CODEX_HOME?.trim()
  const root = raw ? (raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw) : join(homedir(), '.codex')
  return join(root, 'thread-writer-locks', `${session}.lock`)
}

/** ファイルを開いているプロセスの pid。誰も開いていなければ空。確かめる手段が無ければ投げる */
export type LockHolders = (path: string) => Promise<number[]>

/** `lsof -t <path>`（macOS / Linux にある）。誰も開いていなければ何も出さずに 1 で終わる */
export const lsofHolders: LockHolders = (path) =>
  new Promise((resolve, reject) => {
    execFile('lsof', ['-t', path], { timeout: 5_000 }, (err, stdout) => {
      const pids = String(stdout).split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0)
      if (!err || pids.length > 0) return resolve(pids)
      // 終わり方のエラーの code は終了コード（数値）、起動できなかったときは 'ENOENT' などの文字列
      if ((err as { code?: unknown }).code === 1) return resolve([])
      reject(err)
    })
  })

/**
 * 開いている Codex が writer を持っているか。**lock のファイルがあるだけでは開いているとみなさない**（#329）。
 * 生きている Codex は lock を開いたままにしているが、プロセスが終わっても（C-c・サーバの立て直しで app-server ごと落ちた、など）
 * ファイルは消えずに残る。残骸を「開いている」と読むと、閉じたセッションへの返信を誰も受け取らない queue に渡してしまう。
 * 開いているかを確かめられない（lsof が無い）ときは、今までどおり lock があれば開いている扱い（本当に開いていたら resume が writer と競合する）
 */
export async function codexWriterActive(session: string, env: NodeJS.ProcessEnv = process.env, holders: LockHolders = lsofHolders): Promise<boolean> {
  const path = codexWriterLockPath(session, env)
  if (!path) return false
  try {
    if (!(await stat(path)).isFile()) return false
  } catch {
    return false
  }
  try {
    return (await holders(path)).length > 0
  } catch {
    return true
  }
}

/** active writer を持つ Codex へ、resume せず app-server 経由でメッセージを足すコマンド。 */
export function codexQueueCommand(
  session: string,
  text: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  model?: string,
  attachments: readonly string[] = [],
): ReplyCommand {
  const pick = model ? ['-m', model] : []
  const images = attachments.flatMap((path) => ['-i', path])
  return {
    bin: 'codex',
    args: ['queue', ...splitArgs(env.SAI_CODEX_ARGS), ...pick, ...images, '--thread', session, '--message', text],
    cwd,
    text,
  }
}

/** queue は受付結果がすぐ返るので終了まで待ち、失敗を 202 にしない。 */
export type CodexQueue = (cmd: ReplyCommand) => Promise<void>

export const runCodexQueue: CodexQueue = (cmd) =>
  new Promise((resolve, reject) => {
    // ここも SAI が起動する子なので、サーバのペインを継がせない（#234。queue した先の TUI 自身は
    // 本物のペインを持っているので、ターンの行にはそちらの pane が載る）
    execFile(cmd.bin, cmd.args, { cwd: cmd.cwd, env: childEnv(), timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) return resolve()
      const message = stderr.trim() || err.message
      const failure = new Error(message) as NodeJS.ErrnoException
      failure.code = (err as NodeJS.ErrnoException).code
      reject(failure)
    })
  })
