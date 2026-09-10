// 各エージェントの使用量（usage limit）を**ローカルのファイルから読むだけ**（#216）。
// API は叩かない（「SAI は外に出さない」。OAuth のトークンにも触らない）。
//
// 読む先はホーム（と CODEX_HOME）から固定で組み立て、リクエストからは受け取らない（permissions.ts / diff.ts と同じ）。
//
//   Codex … CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl の `token_count` の行の rate_limits。
//            手元の一番大きい rollout は 12MB あったので**末尾だけ**読む（TAIL_BYTES）。
//   Claude … 割合は feed dir の `usage-claude[.<host>].json`（feed/statusline.py が
//            ステータスライン経由で書く。#250）。**これが平常時の割合を知る唯一の口**。
//            加えて ~/.claude/projects/*/*.jsonl の `quotaLimits` を見る。こちらは
//            **弾かれたときにしか載らない**ので、戻る時刻がまだ先の記録だけを拾う（＝いま上限中）。
//
// 3 秒のポーリングには乗せない。画面が開いたときに 1 回取り、CACHE_MS の間は使い回す。
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mergeClaudeUsage, parseClaudeUsage, parseCodexUsage, parseStatusLineUsage } from '../shared/usage.ts'
import type { ClaudeUsage, CodexUsage, UsageResponse } from '../shared/types.ts'

/** ファイルの末尾から読む量。手元の rollout では 64KB で最後の token_count に届いた */
export const TAIL_BYTES = 64 * 1024
/** 見る rollout の数（mtime の新しい順）。一番新しいファイルに枠が載っていないことがあるので少し余分に */
export const CODEX_FILES = 5
/** 候補を集めるために降りる日付ディレクトリの数。これより古い日のファイルは stat もしない */
export const CODEX_DAYS = 14
/** 見る transcript の数（mtime の新しい順） */
export const CLAUDE_FILES = 10
/**
 * transcript を見に行く古さの上限。上限に当たった記録が「いまも効いている」なら、
 * 一番長い枠（週）でもこの中に書かれている
 */
export const CLAUDE_WINDOW_MS = 8 * 24 * 60 * 60 * 1000
/** 結果を使い回す時間。割合は 1 ターンごとにしか動かないので短くなくてよい */
export const CACHE_MS = 30_000

/** `~` 始まりを展開する。CODEX_HOME は人が書く値なので（server/codex.ts と同じ扱い） */
function expand(raw: string, home: string): string {
  if (raw === '~') return home
  return raw.startsWith('~/') ? join(home, raw.slice(2)) : raw
}

export function codexSessionsDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.CODEX_HOME?.trim()
  return join(raw ? expand(raw, home) : join(home, '.codex'), 'sessions')
}

export const claudeProjectsDir = (home: string = homedir()): string => join(home, '.claude', 'projects')

/** feed dir に置かれる使用率のファイル。`usage-claude.json` と、マシンごとに分けた `usage-claude.<host>.json` */
export const isClaudeUsageFile = (name: string): boolean => /^usage-claude(\.[^/]+)?\.json$/.test(name)

/** ファイル 1 つ分。mtime で新しい順に並べるために持つ */
interface Candidate {
  path: string
  mtimeMs: number
}

const newestFirst = (a: Candidate, b: Candidate) => b.mtimeMs - a.mtimeMs

async function statOf(path: string): Promise<Candidate | null> {
  try {
    const st = await stat(path)
    return st.isFile() ? { path, mtimeMs: st.mtimeMs } : null
  } catch {
    return null
  }
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/**
 * rollout を **mtime の新しい順**に limit 件。`sessions/YYYY/MM/DD/` を新しい日付から CODEX_DAYS 日ぶんだけ降りる
 * （何年ぶんあっても最初の数日しか stat しない。古い Codex が sessions/ 直下に置いた .json は rate_limits を持たないので拾わない）。
 *
 * 日付の新しさで打ち切らないのは、**開きっぱなしのセッションは古い日のファイルに追記され続ける**ため
 * （手元では 9/4 のファイルが 9/9 まで書かれていて、9/9 のどのファイルより新しかった）。
 */
export async function recentRollouts(sessionsDir: string, limit = CODEX_FILES): Promise<string[]> {
  const found: Candidate[] = []
  const desc = (list: string[]) => list.filter((n) => /^\d+$/.test(n)).sort((a, b) => b.localeCompare(a))
  let days = 0
  for (const year of desc(await names(sessionsDir))) {
    for (const month of desc(await names(join(sessionsDir, year)))) {
      for (const day of desc(await names(join(sessionsDir, year, month)))) {
        if (days++ >= CODEX_DAYS) return found.sort(newestFirst).slice(0, limit).map((c) => c.path)
        const dir = join(sessionsDir, year, month, day)
        for (const name of await names(dir)) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
          const c = await statOf(join(dir, name))
          if (c) found.push(c)
        }
      }
    }
  }
  return found.sort(newestFirst).slice(0, limit).map((c) => c.path)
}

/** transcript を新しい順に limit 件。since より古いものは見ない（もう戻っている記録しか無い） */
export async function recentTranscripts(projectsDir: string, since: number, limit = CLAUDE_FILES): Promise<string[]> {
  const found: Candidate[] = []
  for (const project of await names(projectsDir)) {
    for (const name of await names(join(projectsDir, project))) {
      if (!name.endsWith('.jsonl')) continue
      const c = await statOf(join(projectsDir, project, name))
      if (c && c.mtimeMs >= since) found.push(c)
    }
  }
  return found.sort(newestFirst).slice(0, limit).map((c) => c.path)
}

/**
 * ファイルの末尾 bytes を読む。行の途中から始まるので、最初の改行までは捨てる
 * （小さいファイルは丸ごと読むので捨てない）
 */
export async function tailLines(path: string, bytes = TAIL_BYTES): Promise<string[]> {
  let fh
  try {
    fh = await open(path, 'r')
  } catch {
    return []
  }
  try {
    const size = (await fh.stat()).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(Math.min(size, bytes))
    if (buf.length === 0) return []
    await fh.read(buf, 0, buf.length, start)
    const lines = buf.toString('utf-8').split('\n')
    // 先頭は途中で切れている（ファイルの頭から読めたときだけ残す）
    if (start > 0) lines.shift()
    return lines
  } catch {
    return []
  } finally {
    await fh.close()
  }
}

/** 1 行ずつ JSON にして pick に渡し、**最後に取れたもの**を返す（新しい行ほど後ろにある） */
function lastOf<T>(lines: readonly string[], pick: (row: unknown) => T | null): T | null {
  let found: T | null = null
  for (const line of lines) {
    if (!line.trim()) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue // 書きかけの行。壊れていても読めるところだけ使う
    }
    const hit = pick(row)
    if (hit) found = hit
  }
  return found
}

/** ISO の時刻で新しい方。時刻が取れないものは負ける */
const newer = <T extends { at: string }>(a: T | null, b: T | null): T | null => {
  if (!a) return b
  if (!b) return a
  return Date.parse(b.at) > Date.parse(a.at) ? b : a
}

export async function readCodexUsage(sessionsDir: string): Promise<CodexUsage | null> {
  let best: CodexUsage | null = null
  for (const path of await recentRollouts(sessionsDir)) {
    best = newer(best, lastOf(await tailLines(path), parseCodexUsage))
  }
  return best
}

/**
 * ステータスライン経由の割合。マシンごとに分かれていることがあるので全部読み、**一番新しいもの**を採る
 * （口座ごとの値なので、どのマシンで測ったかは問わない）。ファイルは小さいので丸ごと読む
 */
export async function readStatusLineUsage(feedDir: string, now: number): Promise<ClaudeUsage | null> {
  let best: ClaudeUsage | null = null
  for (const name of await names(feedDir)) {
    if (!isClaudeUsageFile(name)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(join(feedDir, name), 'utf-8'))
    } catch {
      continue // 書きかけ・壊れている。読めるものだけ使う
    }
    best = newer(best, parseStatusLineUsage(parsed, now))
  }
  return best
}

export async function readClaudeUsage(projectsDir: string, now: number): Promise<ClaudeUsage | null> {
  let best: ClaudeUsage | null = null
  for (const path of await recentTranscripts(projectsDir, now - CLAUDE_WINDOW_MS)) {
    best = newer(best, lastOf(await tailLines(path), (row) => parseClaudeUsage(row, now)))
  }
  return best
}

/**
 * `GET /api/usage` の中身。CACHE_MS の間は使い回す（画面を開き直すたびにファイルを漁らない）。
 * どちらのエージェントも読めなければ空の `{}`（画面は黙って何も出さない）
 */
export class UsageStore {
  readonly codexDir: string
  readonly claudeDir: string
  readonly feedDir: string
  private cached: { at: number; usage: UsageResponse } | null = null
  private pending: Promise<UsageResponse> | null = null
  private readonly now: () => number

  // パラメータプロパティは server/tsconfig.json の erasableSyntaxOnly で使えないので、素直に代入する
  constructor(
    codexDir: string = codexSessionsDir(),
    claudeDir: string = claudeProjectsDir(),
    feedDir: string = join(homedir(), '.agent-feed'),
    now: () => number = Date.now,
  ) {
    this.codexDir = codexDir
    this.claudeDir = claudeDir
    this.feedDir = feedDir
    this.now = now
  }

  async get(): Promise<UsageResponse> {
    const at = this.now()
    if (this.cached && at - this.cached.at < CACHE_MS) return this.cached.usage
    // 同時に開かれても読むのは 1 回だけ
    if (this.pending) return this.pending
    this.pending = this.read(at).finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async read(at: number): Promise<UsageResponse> {
    // 割合（ステータスライン）と「上限中」（transcript）は出どころが別なので、両方読んで重ねる
    const [codex, windows, limited] = await Promise.all([
      readCodexUsage(this.codexDir),
      readStatusLineUsage(this.feedDir, at),
      readClaudeUsage(this.claudeDir, at),
    ])
    const claude = mergeClaudeUsage(windows, limited)
    const usage: UsageResponse = {}
    if (codex) usage.codex = codex
    if (claude) usage.claude = claude
    this.cached = { at, usage }
    return usage
  }
}
