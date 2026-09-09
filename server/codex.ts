import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
