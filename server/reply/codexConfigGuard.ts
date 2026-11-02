// Codex を起こす前の確かめ（#856）。Codex は起動する cwd からリポジトリの一番上までの `.codex/`（設定・ルール）を読むので、
// 一番上ではないディレクトリに置かれた `.codex/` に人が気づけるようにする。**読むだけ**で、`.codex/` の中身を書き換えない・消さない。
// 中身はハッシュにするだけで、画面に出すのはファイルの名前まで。分からないときは止める側に倒す
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { CodexConfigAsk } from '../../shared/types.ts'
import type { Git } from '../git/diff.ts'
import { softWait } from './softWait.ts'

/** 「このまま起こす」を押したものの置き場（feed dir の下）。`.codex` の絶対パス → 押したときの中身のハッシュ */
export const CODEX_CONFIG_ALLOWED_FILE = 'codex-config-allowed.json'
/** 確かめを待つ上限。返らない git・落ちたマウントでは止める側に倒す */
export const CODEX_CONFIG_WAIT_MS = 5_000
/** 中身を見る項目数の上限。超えたら覚えない（押した 1 回だけ通す） */
export const CODEX_CONFIG_MAX_ENTRIES = 2_000
/** 画面に出すファイルの数 */
export const CODEX_CONFIG_SHOWN = 20
/** 覚えられないものに「このまま起こす」を押したとき、押した分が効く長さ */
export const CODEX_CONFIG_ONCE_MS = 10 * 60_000

/** 見つけた `.codex` 1 つ */
export interface CodexConfigDir {
  /** `.codex` の絶対パス（realpath のあと） */
  dir: string
  /** 中身のハッシュ。**空は「覚えられない」**（読めない・シンボリックリンク・多すぎる） */
  hash: string
  /** リポジトリの一番上からの相対のファイル名 */
  files: string[]
}

export type CodexConfigScan = { kind: 'ok'; dirs: CodexConfigDir[] } | { kind: 'unknown'; note: string }

const missing = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** `.codex` を読む。シンボリックリンクは先が変わっても分からないので、読み切れないものと同じく「覚えられない」にする */
async function readCodexDir(dir: string, rel: string): Promise<CodexConfigDir> {
  const hash = createHash('sha256')
  const files: string[] = []
  let opaque = false
  let seen = 0
  const walk = async (at: string, name: string): Promise<void> => {
    const entries = (await readdir(at, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (++seen > CODEX_CONFIG_MAX_ENTRIES) {
        opaque = true
        return
      }
      const path = join(at, e.name)
      const shown = join(name, e.name)
      if (e.isDirectory()) {
        hash.update(`d\0${shown}\0`)
        await walk(path, shown)
        continue
      }
      files.push(shown)
      if (!e.isFile()) {
        opaque = true
        continue
      }
      hash.update(`f\0${shown}\0`)
      await pipeline(createReadStream(path), async (source) => {
        for await (const chunk of source) hash.update(chunk as Buffer)
      })
      hash.update('\0')
    }
  }
  try {
    const info = await lstat(dir)
    if (info.isDirectory()) await walk(dir, rel)
    else {
      files.push(rel)
      opaque = true
    }
  } catch {
    if (files.length === 0) files.push(rel)
    opaque = true
  }
  return { dir, hash: opaque ? '' : hash.digest('hex'), files }
}

/** `top` の親のどこかに別の git の作業ツリーがあるか。読めなければ、あることにする */
async function insideAnotherRepo(top: string): Promise<boolean> {
  for (let d = dirname(top); ; d = dirname(d)) {
    const here = await lstat(join(d, '.git')).then(() => true, (err: unknown) => !missing(err))
    if (here) return true
    if (d === dirname(d)) return false
  }
}

/**
 * `cwd` からリポジトリの一番上までの途中にある `.codex` を探す。**一番上の `.codex` は見ない**（`cwd` が一番上なら何もしない）。
 * ただし**そのリポジトリが別のリポジトリの中にある**（入れ子・中に置いた worktree）ときは、一番上の `.codex` も途中として見る。
 * git が読めなければ `unknown`
 */
export async function scanCodexConfig(git: Git, cwd: string): Promise<CodexConfigScan> {
  let real: string
  let top: string
  try {
    real = await realpath(cwd)
    top = await realpath((await git.run(real, ['rev-parse', '--show-toplevel'])).trim())
  } catch {
    return { kind: 'unknown', note: 'git の作業ツリーの一番上が読めません' }
  }
  const rel = relative(top, real)
  if (rel === '..' || rel.startsWith(`..${sep}`)) return { kind: 'unknown', note: '作業ディレクトリが git の作業ツリーの外です' }
  const places: string[] = []
  for (let d = real; d !== top; d = dirname(d)) places.push(d)
  if (await insideAnotherRepo(top)) places.push(top)
  const dirs: CodexConfigDir[] = []
  for (const place of places) {
    const dir = join(place, '.codex')
    const exists = await lstat(dir).then(() => true, (err: unknown) => !missing(err))
    if (exists) dirs.push(await readCodexDir(dir, relative(top, dir)))
  }
  return { kind: 'ok', dirs }
}

/** `check()` が止めたときに返す、人に見せる形。`allow()` は同じ `fingerprint` のときだけ通す */
export interface CodexConfigGate {
  /** 起こしてよければ null。止めるなら人に見せるもの */
  check(cwd: string): Promise<CodexConfigAsk | null>
  /** 人の「このまま起こす」。通したら null、見せたものと変わっていれば新しい形を返す（覚えない） */
  allow(cwd: string, fingerprint: string): Promise<CodexConfigAsk | null>
}

/** `createApp()` の既定。見ない（本物の git とファイルを見るのは `main.ts` が組んだものだけ） */
export const noCodexConfigGate: CodexConfigGate = { check: async () => null, allow: async () => null }

export class CodexConfigGuard implements CodexConfigGate {
  private readonly git: Git
  private readonly file: string
  private readonly now: () => number
  private readonly waitMs: number
  /** 覚えられないものに押した 1 回（`cwd\n指紋` → 期限）。プロセスの中だけで、使ったら消える */
  private readonly once = new Map<string, number>()

  constructor(git: Git, dir: string, opts: { now?: () => number; waitMs?: number } = {}) {
    this.git = git
    this.file = join(dir, CODEX_CONFIG_ALLOWED_FILE)
    this.now = opts.now ?? Date.now
    this.waitMs = opts.waitMs ?? CODEX_CONFIG_WAIT_MS
  }

  private async load(): Promise<Record<string, string>> {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8'))
    } catch {
      // 無い・壊れている → 何も覚えていない（もう一度聞く側）
    }
    const out: Record<string, string> = {}
    if (parsed && typeof parsed === 'object') {
      for (const [dir, hash] of Object.entries(parsed)) if (typeof hash === 'string' && hash) out[dir] = hash
    }
    return out
  }

  private scan(cwd: string): Promise<CodexConfigScan> {
    return softWait(
      scanCodexConfig(this.git, cwd).catch((): CodexConfigScan => ({ kind: 'unknown', note: '確かめられませんでした' })),
      (): CodexConfigScan => ({ kind: 'unknown', note: '確かめが時間内に終わりませんでした' }),
      this.waitMs,
    )
  }

  private async ask(scan: CodexConfigScan): Promise<CodexConfigAsk | null> {
    if (scan.kind === 'unknown') {
      return { reason: 'unknown', files: [], more: 0, note: scan.note, fingerprint: createHash('sha256').update(`unknown\0${scan.note}`).digest('hex') }
    }
    const allowed = await this.load()
    const open = scan.dirs.filter((d) => !d.hash || allowed[d.dir] !== d.hash)
    if (open.length === 0) return null
    const files = open.flatMap((d) => d.files)
    // 指紋は見つけたもの全部から作る（押して覚えたあとも、覚えられなかった分の押した 1 回を同じ鍵で引けるように）
    const fingerprint = createHash('sha256').update(JSON.stringify(scan.dirs.map((d) => [d.dir, d.hash, d.files]))).digest('hex')
    return { reason: 'found', files: files.slice(0, CODEX_CONFIG_SHOWN), more: Math.max(0, files.length - CODEX_CONFIG_SHOWN), note: '', fingerprint }
  }

  async check(cwd: string): Promise<CodexConfigAsk | null> {
    const ask = await this.ask(await this.scan(cwd))
    if (!ask) return null
    const key = `${cwd}\n${ask.fingerprint}`
    const until = this.once.get(key) ?? 0
    this.once.delete(key)
    return until > this.now() ? null : ask
  }

  async allow(cwd: string, fingerprint: string): Promise<CodexConfigAsk | null> {
    // 指紋を比べたのと同じ読みのハッシュを覚える（比べたあとに変わっていれば、次の `check()` がハッシュの違いで止める）
    const scan = await this.scan(cwd)
    const ask = await this.ask(scan)
    if (!ask) return null
    if (ask.fingerprint !== fingerprint) return ask
    if (scan.kind === 'ok') {
      const allowed = await this.load()
      for (const d of scan.dirs) if (d.hash) allowed[d.dir] = d.hash
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(allowed, null, 2))
      await rename(tmp, this.file)
    }
    // 覚えられない分（読めない・git が読めない）は押した 1 回だけ通す
    if (scan.kind === 'unknown' || scan.dirs.some((d) => !d.hash)) this.once.set(`${cwd}\n${fingerprint}`, this.now() + CODEX_CONFIG_ONCE_MS)
    return null
  }
}
