// 未読の印（#502）。~/.agent-feed/read-marks.json に { since, sessions: { <id>: <ミリ秒> } } で持つ。
// **サーバを立て直しても消えない**（#440 と同じ轍を踏まない）。画面の localStorage に置かないのは、Mac と携帯で揃えるため。
// ProfileStore と同じく (mtime, size) で覚えて変わらなければ読み直さず、tmp に書いて rename する
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { nextMark, readMarkOf, type ReadMarks } from '../../shared/unread.ts'

export const READ_MARKS_FILE = 'read-marks.json'

/** 覚えておくセッションの数の上限。古い印から捨てる（捨てたセッションは `since` まで読んだ扱いに戻る） */
export const READ_MARKS_MAX = 2000

function parse(text: string): ReadMarks | null {
  const obj = JSON.parse(text) as unknown
  if (!obj || typeof obj !== 'object') return null
  const { since, sessions } = obj as { since?: unknown; sessions?: unknown }
  if (typeof since !== 'number' || !Number.isFinite(since)) return null
  const out: Record<string, number> = {}
  if (sessions && typeof sessions === 'object') {
    for (const [id, ms] of Object.entries(sessions as Record<string, unknown>)) {
      if (typeof ms === 'number' && Number.isFinite(ms)) out[id] = ms
    }
  }
  return { since, sessions: out }
}

export class ReadStore {
  readonly path: string
  private readonly now: () => number
  private cache: { mtimeMs: number; size: number; marks: ReadMarks } | null = null
  // 書き込みを 1 本ずつにする（読んだ・未読に戻したが続けて来ても、片方が消えないように）
  private chain: Promise<unknown> = Promise.resolve()
  // 無い・壊れたファイルを作り直す 1 本（最初の起動で一覧・フィード・詳細が同時に来ても、作るのは 1 回だけ）
  private resetting: Promise<void> | null = null

  constructor(path: string, now: () => number = Date.now) {
    this.path = path
    this.now = now
  }

  /**
   * いまの印。**ファイルが無い・壊れていれば「いま」を `since` にして作る**（入れた瞬間に過去のターンを全部未読にしない）。
   * rev はファイルの (mtime, size)
   */
  async get(): Promise<{ rev: string; marks: ReadMarks }> {
    let st
    try {
      st = await stat(this.path)
    } catch {
      await this.reset()
      st = await stat(this.path)
    }
    const rev = `${st.mtimeMs}:${st.size}`
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return { rev, marks: this.cache.marks }
    let marks: ReadMarks | null = null
    try {
      marks = parse(await readFile(this.path, 'utf-8'))
    } catch {
      marks = null
    }
    if (!marks) {
      await this.reset()
      return this.get()
    }
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, marks }
    return { rev, marks }
  }

  /**
   * 印を置く。`back` が無ければ前にしか進めない（`nextMark()`）。変わらなければ書かない。置いたあとの印を返す
   */
  async mark(id: string, wanted: number, back: boolean): Promise<number> {
    const run = this.chain.then(async () => {
      const { marks } = await this.get()
      const current = readMarkOf(marks, id)
      const next = nextMark(current, wanted, back)
      if (next === null) return current
      const sessions = { ...marks.sessions }
      delete sessions[id] // 置き直したものを一番新しい扱いにする（上限で捨てる順）
      sessions[id] = next
      const ids = Object.keys(sessions)
      for (const old of ids.slice(0, Math.max(0, ids.length - READ_MARKS_MAX))) delete sessions[old]
      await this.write({ since: marks.since, sessions })
      return next
    })
    this.chain = run.catch(() => undefined)
    return run
  }

  /** 「いま」を起点に作り直す。同時に来たら同じ 1 本を待つ */
  private reset(): Promise<void> {
    this.resetting ??= this.write({ since: this.now(), sessions: {} }).finally(() => {
      this.resetting = null
    })
    return this.resetting
  }

  private async write(marks: ReadMarks): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    // tmp は書くたびに別の名前にする（同じ名前だと、重なった書き込みの片方の rename が ENOENT で落ちる）
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(marks) + '\n', 'utf-8')
    await rename(tmp, this.path)
    this.cache = null
  }
}
