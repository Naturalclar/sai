// 成果の確認の記録（#903）。~/.agent-feed/result-checks.json に { checks: { <鍵>: <確認済みにした時刻> } } で持つ。
// 鍵は `checkKey(送り元, 相手, 成果の返答の行の ts)`（shared/agentResults.ts）。**SAI の上の記録だけ**で、CLI の許可・GitHub の承認・
// マージ・公開・頼み直しには使わない。立て直しても消えない（未読の印 `meta/reads.ts` と同じく (mtime, size) で覚え、tmp に書いて rename する）
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

export const RESULT_CHECKS_FILE = 'result-checks.json'

/** 覚えておく確認の数の上限。古いものから捨てる（捨てた成果は、窓に残っていれば確認待ちに戻る） */
export const RESULT_CHECKS_MAX = 2000

function parse(text: string): Record<string, string> {
  const obj = JSON.parse(text) as unknown
  const checks = obj && typeof obj === 'object' ? (obj as { checks?: unknown }).checks : undefined
  const out: Record<string, string> = {}
  if (checks && typeof checks === 'object') {
    for (const [k, v] of Object.entries(checks as Record<string, unknown>)) {
      if (typeof v === 'string' && Number.isFinite(Date.parse(v))) out[k] = v
    }
  }
  return out
}

export class ResultChecks {
  readonly path: string
  private readonly now: () => Date
  private cache: { mtimeMs: number; size: number; checks: Record<string, string> } | null = null
  // 書き込みを 1 本ずつにする（続けて押しても片方が消えないように）
  private chain: Promise<unknown> = Promise.resolve()

  constructor(path: string, now: () => Date = () => new Date()) {
    this.path = path
    this.now = now
  }

  /** いまの記録。ファイルが無い・壊れていれば空（作らない。押したときに初めて書く） */
  async all(): Promise<ReadonlyMap<string, string>> {
    let st
    try {
      st = await stat(this.path)
    } catch {
      return new Map()
    }
    if (!this.cache || this.cache.mtimeMs !== st.mtimeMs || this.cache.size !== st.size) {
      let checks: Record<string, string> = {}
      try {
        checks = parse(await readFile(this.path, 'utf-8'))
      } catch {
        checks = {}
      }
      this.cache = { mtimeMs: st.mtimeMs, size: st.size, checks }
    }
    return new Map(Object.entries(this.cache.checks))
  }

  /** 確認済みにする（`checked`）・取り消す。置いたあとの時刻（取り消したら undefined）。同じ状態なら書かない */
  async set(key: string, checked: boolean): Promise<string | undefined> {
    const run = this.chain.then(async () => {
      const checks = Object.fromEntries(await this.all())
      const current = checks[key]
      if (checked && current) return current
      if (!checked && !current) return undefined
      if (checked) {
        checks[key] = this.now().toISOString()
        const keys = Object.keys(checks)
        for (const old of keys.slice(0, Math.max(0, keys.length - RESULT_CHECKS_MAX))) delete checks[old]
      } else {
        delete checks[key]
      }
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify({ checks }) + '\n', 'utf-8')
      await rename(tmp, this.path)
      this.cache = null
      return checked ? checks[key] : undefined
    })
    this.chain = run.catch(() => undefined)
    return run
  }
}
