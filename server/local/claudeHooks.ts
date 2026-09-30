// Claude Code のフックの配線のずれを、画面に出すために読む（#567）。**読むだけ**で設定は書き換えない。
// 判定は shared/hooks.ts の claudeHookGaps()（`/setup-sai` も同じものを `server/hooksCheck.ts` から使う）。
// 3 秒のポーリングのたびに読まない: ttlMs に 1 回だけ設定ファイルの mtime を見て、変わったときだけ読み直す。
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { claudeHookGaps, hookGapLabel, type ReachesRecord } from '../../shared/hooks.ts'

/** 既定で読む設定。ユーザーの設定だけ（プロジェクト側はセッションごとに違うので、画面の 1 本のバナーには混ぜない） */
export function defaultClaudeSettingsPaths(home = homedir()): string[] {
  return [join(home, '.claude', 'settings.json')]
}

/** ラッパーの中身は頭だけ読めば足りる（`record.py` を呼ぶ 1 行があるか） */
const WRAPPER_HEAD_BYTES = 64 * 1024

/** コマンドの先頭の語（引用符を外し、`~` と `$HOME` を開く） */
function firstWord(command: string, home: string): string {
  const m = command.trim().match(/^(?:"([^"]*)"|'([^']*)'|(\S+))/)
  const word = m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''
  return word.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home)
}

/** PATH から実行ファイルを引く（`/` を含めばそのまま） */
function which(exe: string, path: string): string | null {
  if (!exe) return null
  const candidates = exe.includes('/') ? [exe] : path.split(delimiter).filter(Boolean).map((d) => join(d, exe))
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c
    } catch {
      // 無い
    }
  }
  return null
}

function readHead(file: string): string {
  try {
    return readFileSync(file).subarray(0, WRAPPER_HEAD_BYTES).toString('utf-8')
  } catch {
    return ''
  }
}

/**
 * `/setup-sai` の `reaches()` と同じ規則: コマンドに `record.py` を含むか、先頭の語を PATH で引けるスクリプトの中身が
 * `record.py` を呼ぶ。サーバの PATH で引くので、エージェントとサーバで PATH が違えば引けないことがある（そのときは
 * 届いていない側に数えるが、1 つも届かなければ判定は「分からない」になって何も出さない）
 */
export function reachesRecord(opts: { path?: string; home?: string; read?: (file: string) => string } = {}): ReachesRecord {
  const path = opts.path ?? process.env.PATH ?? ''
  const home = opts.home ?? homedir()
  const read = opts.read ?? readHead
  return (command) => {
    if (command.includes('record.py')) return true
    const file = which(firstWord(command, home), path)
    return file !== null && read(file).includes('record.py')
  }
}

export interface ClaudeHooksOptions {
  ttlMs?: number
  reaches?: ReachesRecord
}

/**
 * いま足りないフック（`hookGapLabel()` の 1 行ずつ）。**`null` は「分からない」**（設定が無い・読めない・
 * `record.py` に届くフックが 1 つも見つからない）で、画面は何も出さない。全部揃っていれば空。
 */
export class ClaudeHooks {
  private readonly paths: string[]
  private readonly ttlMs: number
  private readonly reaches: ReachesRecord
  /** 最後に設定ファイルを見た時刻（まだ見ていなければ null） */
  private checked: number | null = null
  private signature = ''
  private value: string[] | null = null

  constructor(paths: string[] = defaultClaudeSettingsPaths(), opts: ClaudeHooksOptions = {}) {
    this.paths = paths
    this.ttlMs = opts.ttlMs ?? 30_000
    this.reaches = opts.reaches ?? reachesRecord()
  }

  missing(now = Date.now()): string[] | null {
    if (this.checked !== null && now - this.checked < this.ttlMs) return this.value
    this.checked = now
    const sig = this.paths.map((p) => {
      try {
        const st = statSync(p)
        return `${st.mtimeMs}:${st.size}`
      } catch {
        return '-'
      }
    }).join('|')
    if (sig === this.signature) return this.value
    this.signature = sig
    const settings: unknown[] = []
    for (const p of this.paths) {
      try {
        settings.push(JSON.parse(readFileSync(p, 'utf-8')))
      } catch {
        // 無い・壊れている
      }
    }
    const gaps = settings.length ? claudeHookGaps(settings, this.reaches) : null
    this.value = gaps ? gaps.map(hookGapLabel) : null
    return this.value
  }
}

/** 使わない（テストの既定。本物の ~/.claude を読まない） */
export class NoClaudeHooks {
  missing(): string[] | null {
    return null
  }
}

export type ClaudeHooksReader = Pick<ClaudeHooks, 'missing'>
