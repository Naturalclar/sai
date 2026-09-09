import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ReplyCommand } from './runner.ts'
import { splitArgs } from './runner.ts'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Codex が thread-store の writer を持っている印。ID を検査して CODEX_HOME の外を読ませない。 */
export function codexWriterLockPath(session: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!SESSION_ID.test(session)) return null
  const raw = env.CODEX_HOME?.trim()
  const root = raw ? (raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw) : join(homedir(), '.codex')
  return join(root, 'thread-writer-locks', `${session}.lock`)
}

/** lock は Codex が開いている間だけ存在し、別プロセスの resume は active writer で失敗する。 */
export async function codexWriterActive(session: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const path = codexWriterLockPath(session, env)
  if (!path) return false
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
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
    bin: env.SAI_CODEX_BIN || 'codex',
    args: ['queue', ...splitArgs(env.SAI_CODEX_ARGS), ...pick, ...images, '--thread', session, '--message', text],
    cwd,
    text,
  }
}

/** queue は受付結果がすぐ返るので終了まで待ち、失敗を 202 にしない。 */
export type CodexQueue = (cmd: ReplyCommand) => Promise<void>

export const runCodexQueue: CodexQueue = (cmd) =>
  new Promise((resolve, reject) => {
    execFile(cmd.bin, cmd.args, { cwd: cmd.cwd, timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) return resolve()
      const message = stderr.trim() || err.message
      const failure = new Error(message) as NodeJS.ErrnoException
      failure.code = (err as NodeJS.ErrnoException).code
      reject(failure)
    })
  })
