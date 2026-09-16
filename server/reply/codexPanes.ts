// tmux のペインで動いている Codex を、**記録の行を見ずに**見つける（#417）。
//
// 行（`~/.agent-feed`）は `notify` = ターン完了のときにしか増えないので、**まだ 1 ターンも終えていない
// セッション**（最初のターンの許可で止まった、など）は SAI から存在が見えない。行がある場合でも、
// 記録した pid が死んでいると端末と結びつかない。
//
// **セッション ID は cwd から rollout を引いて取る**（`record.py` の `resolve_codex_session()` と同じ）。
// writer lock から引く手（#332 の案 2）は **codex 0.153.2 でしか当たらない**: 実測で 0.154.0 の TUI は
// lock を開いておらず、そのスレッドの lock は ChatGPT アプリの `codex app-server --listen`（tmux の外）が
// 握っていた。cwd → rollout は record.py が行を書くときに使っているのと同じ引き方なので、版に依らず
// 記録と同じセッションに繋がる。
import { execFile } from 'node:child_process'
import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDescendant, type PsFn, type Tmux } from './terminal.ts'

/** 見つけた結果を覚えておく長さ。3 秒のポーリングのたびに `ps` / `lsof` / rollout の走査を起こさない */
export const CODEX_PANES_TTL_MS = 30_000
/** rollout を探す日数（`progress.ts` の CODEX_DAYS と同じ考え方。古い日に始めて開きっぱなしのものは引かない） */
const ROLLOUT_DAYS = 7
/**
 * rollout の頭から読むバイト数。**1 行目（`session_meta`）だけで実測 18.5KB ある**（環境や指示が入っている）ので、
 * 8KB では切れて JSON として読めない。切れた最後の行は `parseRolloutHead()` が捨てる
 */
const HEAD_BYTES = 64 * 1024

/** tmux のペインで動いている Codex 1 つ */
export interface PaneCodex {
  pane: string
  /** codex 本体の pid（そのペインの子孫） */
  pid: number
  cwd: string
  /** cwd から引いたセッション ID。引けなければ空（まだスレッドが無い Codex） */
  session: string
}

export interface CodexPaneSource {
  scan(): Promise<PaneCodex[]>
}

export interface CodexPaneDeps {
  tmux: Tmux
  /** `ps -axo pid=,ppid=,comm=`。コマンド名が要るので `PsFn`（pid と ppid だけ）とは別 */
  ps?: PsFn
  /** その pid の cwd（既定は `lsof`） */
  cwdOf?: (pid: number) => Promise<string>
  /** その cwd の Codex セッション（既定は CODEX_HOME の rollout を新しい順に見る） */
  sessionOf?: (cwd: string) => Promise<string>
  now?: () => number
  env?: NodeJS.ProcessEnv
}

/** `ps -axo pid=,ppid=,comm=`。comm は空白を含みうるので 3 列目以降をまとめて名前にする */
export const realPsCommands: PsFn = () =>
  new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'pid=,ppid=,comm='], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })

export interface PsRow {
  pid: number
  ppid: number
  /** 実行ファイルの名前だけ（パスは落とす） */
  comm: string
}

export function parsePsCommands(output: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of output.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3]!.trim().split('/').pop() ?? '' })
  }
  return rows
}

/** `lsof -a -p <pid> -d cwd -Fn` の `n` の行。読めなければ空 */
const lsofCwd = (pid: number): Promise<string> =>
  new Promise((resolve) => {
    execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 5_000 }, (err, stdout) => {
      if (err && !stdout) return resolve('')
      const line = String(stdout).split('\n').find((l) => l.startsWith('n'))
      resolve(line ? line.slice(1).trim() : '')
    })
  })

function codexSessionsDir(env: NodeJS.ProcessEnv): string {
  const raw = env.CODEX_HOME?.trim()
  const home = raw ? (raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw) : join(homedir(), '.codex')
  return join(home, 'sessions')
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/** ファイルの頭だけを読む（rollout は手元で 12MB ある。`session_meta` は 1 行目） */
async function head(path: string): Promise<string> {
  let file
  try {
    file = await open(path, 'r')
  } catch {
    return ''
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await file.read(buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, bytesRead).toString('utf-8')
  } catch {
    return ''
  } finally {
    await file.close().catch(() => {})
  }
}

interface RolloutHead {
  cwd: string
  session: string
}

/** rollout の頭から cwd とセッション ID を読む（`record.py` の `_rollout_cwd()` / `_rollout_session_id()` と同じ見方） */
export function parseRolloutHead(text: string, fallbackSession: string): RolloutHead {
  let cwd = ''
  let session = ''
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      // 頭の読み込みで切れた最後の行
      continue
    }
    const payload = entry.payload
    const node = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : entry
    if (!cwd) {
      const value = node.cwd
      if (typeof value === 'string' && value) cwd = value
      else {
        const git = node.git
        const repo = git !== null && typeof git === 'object' ? (git as Record<string, unknown>).repository_path : undefined
        if (typeof repo === 'string' && repo) cwd = repo
      }
    }
    // 子スレッド（レビュー。#403）の rollout でも session_id は親を指すので、ファイル名より先に見る
    if (!session && entry.type === 'session_meta') {
      const value = node.session_id
      if (typeof value === 'string' && value) session = value
    }
    if (cwd && session) break
  }
  return { cwd, session: session || fallbackSession }
}

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/**
 * その cwd で動いている Codex のセッション ID を、**新しい rollout から順に**引く（`record.py` と同じ）。
 * 見つからなければ空。`sessions/YYYY/MM/DD` を新しい日から `ROLLOUT_DAYS` 日ぶんだけ降りる
 */
export function rolloutSessionByCwd(env: NodeJS.ProcessEnv = process.env): (cwd: string) => Promise<string> {
  const root = codexSessionsDir(env)
  return async (cwd: string): Promise<string> => {
    if (!cwd) return ''
    const desc = (list: string[]) => list.filter((n) => /^\d+$/.test(n)).sort((a, b) => b.localeCompare(a))
    let days = 0
    const found: { mtime: number; path: string }[] = []
    for (const year of desc(await names(root))) {
      for (const month of desc(await names(join(root, year)))) {
        for (const day of desc(await names(join(root, year, month)))) {
          if (days++ >= ROLLOUT_DAYS) break
          const dir = join(root, year, month, day)
          for (const name of await names(dir)) {
            if (name.startsWith('rollout-') && name.endsWith('.jsonl')) found.push({ mtime: 0, path: join(dir, name) })
          }
        }
      }
    }
    // 同じ日の中では名前（時刻が入っている）の新しい順
    found.sort((a, b) => b.path.localeCompare(a.path))
    for (const { path } of found) {
      const parsed = parseRolloutHead(await head(path), UUID.exec(path)?.[1] ?? '')
      if (parsed.cwd && parsed.cwd === cwd && parsed.session) return parsed.session
    }
    return ''
  }
}

/**
 * tmux のペインで動いている Codex を数える。**行は見ない**ので、記録が 1 本も無いセッションも拾える。
 *
 * ペインの子孫に `codex` がいるかは `ps` のコマンド名で見て、セッション ID は cwd → rollout で引く。
 * 結果は `CODEX_PANES_TTL_MS` 覚える（3 秒のポーリングで `ps` / `lsof` / rollout の走査を起こさない）
 */
export class CodexPanes implements CodexPaneSource {
  private cache: { at: number; panes: PaneCodex[] } | null = null
  private scanning: Promise<PaneCodex[]> | null = null
  private readonly tmux: Tmux
  private readonly ps: PsFn
  private readonly cwdOf: (pid: number) => Promise<string>
  private readonly sessionOf: (cwd: string) => Promise<string>
  private readonly now: () => number

  constructor(deps: CodexPaneDeps) {
    this.tmux = deps.tmux
    this.ps = deps.ps ?? realPsCommands
    this.cwdOf = deps.cwdOf ?? lsofCwd
    this.sessionOf = deps.sessionOf ?? rolloutSessionByCwd(deps.env ?? process.env)
    this.now = deps.now ?? Date.now
  }

  async scan(): Promise<PaneCodex[]> {
    const hit = this.cache
    if (hit && this.now() - hit.at < CODEX_PANES_TTL_MS) return hit.panes
    // 同時に何本も走らせない（3 秒のポーリングが重なる）
    if (!this.scanning) {
      this.scanning = this.scanNow().finally(() => {
        this.scanning = null
      })
    }
    return this.scanning
  }

  private async scanNow(): Promise<PaneCodex[]> {
    const panes: PaneCodex[] = []
    try {
      const listed = await this.tmux.run(['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}'])
      const shells = listed
        .split('\n')
        .map((line) => line.trim().match(/^(%\d+)\s+(\d+)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => ({ pane: m[1]!, pid: Number(m[2]) }))
      if (shells.length) {
        const rows = parsePsCommands(await this.ps())
        const parents = new Map(rows.map((r) => [r.pid, r.ppid]))
        for (const row of rows) {
          if (row.comm !== 'codex') continue
          const shell = shells.find((s) => isDescendant(row.pid, s.pid, parents))
          if (!shell) continue // tmux の外（ChatGPT アプリの app-server など）
          const cwd = await this.cwdOf(row.pid)
          const session = cwd ? await this.sessionOf(cwd) : ''
          panes.push({ pane: shell.pane, pid: row.pid, cwd, session })
        }
      }
    } catch {
      // tmux が無い・ps が読めないときは「1 つも開いていない」ではなく**前の結果を捨てない**
      return this.cache?.panes ?? []
    }
    this.cache = { at: this.now(), panes }
    return panes
  }
}
