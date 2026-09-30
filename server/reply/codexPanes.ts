// tmux のペインで動いている Codex を、**記録の行を見ずに**見つける（#417）。
//
// 行（`~/.agent-feed`）は `notify` = ターン完了のときにしか増えないので、**まだ 1 ターンも終えていない
// セッション**（最初のターンの許可で止まった、など）は SAI から存在が見えない。行がある場合でも、
// 記録した pid が死んでいると端末と結びつかない。
//
// **セッション ID は、まずそのペインの codex が「いま開いている rollout」から取る**（#429）。
// writer lock から引く手（#332 の案 2）は **codex 0.153.2 でしか当たらない**: 実測で 0.154.0 の TUI は
// lock を開いておらず、そのスレッドの lock は ChatGPT アプリの `codex app-server --listen`（tmux の外）が
// 握っていた。
//
// **cwd から引いてはいけない**（#429）: 前は `record.py` の `resolve_codex_session()` と同じく
// 「その cwd の一番新しい rollout」を引いていたが、あちらは**その codex 自身が書いた行**を処理するので
// 当たる一方、こちらは**ペイン → セッション**を当てる向きで、同じ worktree に会話が 2 本あると崩れる。
// 端末で 1 本開いたまま SAI から新しいセッションを起こす（#401）と、新しい方の rollout が一番新しくなり、
// **ペインの導出セッションが別の会話に化けて、返信がそのペインに打ち込まれた**。開いているファイルなら
// 取り違えようがない。0.154.0 の TUI は放置すると fd を閉じるため、開いていないときだけプロセスの
// **開始秒と rollout 名が一致**し、さらに cwd も一致する一意のものへ落とす（#448）。
// **それでも引けなければ当てない**（`session` は空。材料が無いのに決めつけない）。
import { execFile } from 'node:child_process'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { isDescendant, type PsFn, type Tmux } from './terminal.ts'

/** 見つけた結果を覚えておく長さ。3 秒のポーリングのたびに `ps` / `lsof` / rollout の走査を起こさない */
export const CODEX_PANES_TTL_MS = 30_000
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
  /** 開いている rollout、または開始秒で裏を取った rollout のセッション ID。引けなければ空 */
  session: string
}

export interface CodexPaneSource {
  scan(): Promise<PaneCodex[]>
  /** 前回の結果（走査を起こさない。#495 の締切で使う）。偽物は持たなくてよい */
  last?(): PaneCodex[]
}

/** その pid が開いているもののうち、知りたい 2 つ */
export interface PaneFiles {
  cwd: string
  /** 開いている rollout のパス（CODEX_HOME の下のものだけ） */
  rollouts: string[]
}

export interface CodexPaneDeps {
  tmux: Tmux
  /** `ps -axo pid=,ppid=,comm=`。コマンド名が要るので `PsFn`（pid と ppid だけ）とは別 */
  ps?: PsFn
  /** その pid が開いているファイル（既定は `lsof`）。cwd と rollout を 1 回で取る */
  openOf?: (pid: number) => Promise<PaneFiles>
  /** rollout を開かない TUI のセッション（既定は起動時刻・目印・読み込み中のスレッドで推定する。#448 / #568） */
  sessionAtStart?: (pid: number, cwd: string, pane: string) => Promise<string>
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

/**
 * `lsof -a -p <pid> -Ffn` から cwd と開いている rollout を**1 回で**取る。読めなければ空。
 * 出力は `f<fd>` の次の行が `n<パス>` という形で、cwd は `fcwd`
 */
export function lsofPaneFiles(env: NodeJS.ProcessEnv = process.env, run: LsofRun = runLsof): (pid: number) => Promise<PaneFiles> {
  const dir = codexSessionsDir(env)
  return async (pid: number): Promise<PaneFiles> => {
    const output = await run(pid)
    if (!output) return { cwd: '', rollouts: [] }
    // **root を realpath にも揃えるのはここ**（#434）。`sessionRoots()` と `parsePaneFiles()` が
    // 別々に正しくても、この 1 行を書き戻せば元の壊れ方に戻るので、テストは `run` を差し替えて
    // **この組み立てごと**通す（`lsof` を実際に起こさない）
    return parsePaneFiles(output, await sessionRoots(dir))
  }
}

/** `lsof` を起こして出力を返す口。テストが差し替える（本物は `runLsof`） */
export type LsofRun = (pid: number) => Promise<string>

/** 読めなければ空文字（`lsof` が無い・そのプロセスがもう居ない） */
const runLsof: LsofRun = (pid: number) =>
  new Promise((resolve) => {
    execFile('lsof', ['-a', '-p', String(pid), '-Ffn'], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout))
    })
  })

/**
 * 前方一致に使う置き場。**書いたとおりの形と realpath の両方**を返す（#434）。
 *
 * `lsof` が返すのは**シンボリックリンクを解いた実パス**で（実測: macOS では `/tmp/…` が `/private/tmp/…`、
 * 途中のリンクも解ける）、こちらの `root` は `CODEX_HOME` か `homedir()` を**書いたとおり**に繋いだもの。
 * 表記が違うと前方一致が 1 本も当たらず、**例外も出ないまま開いている rollout が全部落ちて、
 * ペインの Codex の検出（#417）が黙って何も返さない**（`CODEX_HOME` を `/tmp` の下に置く・
 * `~/.codex` を別のボリュームへリンクする、で起きる）。
 *
 * `record.py` の `resolve_codex_session()` が「**比較のときだけ** realpath に揃える」のと同じ考え方で、
 * **返す値（`PaneFiles.rollouts` のパス）は lsof が返したまま**にする（そのまま開くので解いた形の方が正しい）。
 * 両方返すのは、リンクを解かない `lsof` に当たっても今までどおり当たるようにするため。
 * 解けなければ（まだ無いディレクトリ）書いたとおりの形だけ
 */
export async function sessionRoots(dir: string): Promise<string[]> {
  const written = dir + sep
  try {
    const real = (await realpath(dir)) + sep
    return real === written ? [written] : [written, real]
  } catch {
    // まだ Codex を一度も動かしていない（sessions/ が無い）。書いたとおりの形だけで比べる
    return [written]
  }
}

/**
 * `lsof -Ffn` の出力を読む。`roots` は CODEX_HOME の `sessions/`（末尾に区切り付き）で、
 * **書いたとおりの形と realpath の両方**が入りうる（`sessionRoots()`。#434）
 */
export function parsePaneFiles(output: string, roots: readonly string[]): PaneFiles {
  let cwd = ''
  const rollouts: string[] = []
  let fd = ''
  for (const line of output.split('\n')) {
    if (line.startsWith('f')) {
      fd = line.slice(1).trim()
      continue
    }
    if (!line.startsWith('n')) continue
    const path = line.slice(1).trim()
    if (fd === 'cwd') {
      if (!cwd) cwd = path
      continue
    }
    // CODEX_HOME の下の rollout だけ（別のプロセスが開いた同名のファイルを拾わない）
    if (roots.some((root) => path.startsWith(root)) && basename(path).startsWith('rollout-') && path.endsWith('.jsonl')) rollouts.push(path)
  }
  return { cwd, rollouts }
}

function codexSessionsDir(env: NodeJS.ProcessEnv): string {
  const raw = env.CODEX_HOME?.trim()
  const home = raw ? (raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw) : join(homedir(), '.codex')
  return join(home, 'sessions')
}

export interface CodexStart {
  startedAt: Date
  /** `ps` の command。引数なしの対話 TUI かを見分けるために使う */
  command: string
}

/** `ps -p <pid> -o lstart= -o command=` の 1 行。読めない形なら null */
export function parseCodexStart(output: string): CodexStart | null {
  const m = output
    .trim()
    .match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+)$/)
  if (!m) return null
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[1]!)
  const startedAt = new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
  return Number.isNaN(startedAt.getTime()) ? null : { startedAt, command: m[7]!.trim() }
}

type PsStartRun = (pid: number) => Promise<string>

const runPsStart: PsStartRun = (pid: number) =>
  new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { timeout: 5_000 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout))
    })
  })

const two = (n: number): string => String(n).padStart(2, '0')

/** `lsof -a -U -p <pid> -F dn` の出力。自分の unix ソケットの番地（`d`）と、繋がっている相手の番地（`n->`） */
export function parseUnixSockets(output: string): { addrs: Set<string>; peers: Set<string> } {
  const addrs = new Set<string>()
  const peers = new Set<string>()
  for (const line of output.split('\n')) {
    if (/^d0x[0-9a-f]+$/i.test(line)) addrs.add(line.slice(1).toLowerCase())
    const peer = line.match(/^n->(0x[0-9a-f]+)$/i)
    if (peer) peers.add(peer[1]!.toLowerCase())
  }
  return { addrs, peers }
}

/** `client` のソケットのどれかが `server` のソケットに繋がっているか（どちらも `lsof -U -F dn` の出力） */
export function isClientOf(client: string, server: string): boolean {
  const { addrs } = parseUnixSockets(server)
  for (const peer of parseUnixSockets(client).peers) if (addrs.has(peer)) return true
  return false
}

const runUnixSockets = (pid: number): Promise<string> =>
  new Promise((resolve) => {
    execFile('lsof', ['-a', '-U', '-p', String(pid), '-F', 'dn'], { timeout: 5_000 }, (_err, stdout) => resolve(String(stdout ?? '')))
  })

const runHolders = (path: string): Promise<number[]> =>
  new Promise((resolve) => {
    execFile('lsof', ['-t', path], { timeout: 5_000 }, (_err, stdout) =>
      resolve(String(stdout ?? '').split('\n').map(Number).filter((n) => Number.isInteger(n) && n > 0)),
    )
  })

/** 起動時刻で当てるときに外を読む口（#568）。テストが差し替える */
export interface StartProbe {
  /** `ps -p <pid> -o lstart= -o command=` */
  ps: PsStartRun
  /** そのファイルを開いているプロセス（`lsof -t`） */
  holders: (path: string) => Promise<number[]>
  /** そのプロセスの unix ソケット（`lsof -a -U -p <pid> -F dn`） */
  sockets: (pid: number) => Promise<string>
  /** そのプロセスが開いている rollout のパス */
  openRollouts: (pid: number) => Promise<string[]>
  /** そのペインのスクロールバック（`tmux capture-pane`） */
  scrollback: (pane: string) => Promise<string>
}

/** 起動秒から何秒あとまでを「起動したときに作ったスレッド」とみなすか（実測で同じ秒か 1 秒後） */
export const START_SLACK_S = 2

/**
 * rollout を開かない Codex TUI（共有の `codex app-server --listen` の客）が**起動したときに作った会話**（#448 / #568）。
 * TUI はいま映しているスレッド ID をどこにも書かず、app-server にも客ごとのスレッドを聞く口が無い（調査済み）ので、
 * 確実ではない材料を重ね、**どれか 1 つでも合わなければ当てない**:
 *
 * 1. 起動秒〜 `START_SLACK_S` 秒後の名前で、cwd が同じで、TUI が作った目印（`tui-thread-reference-capabilities/<id>`）の
 *    ある rollout がちょうど 1 つ
 * 2. その rollout を開いている app-server に、この TUI が unix ソケットで繋いでいる（客である）
 * 3. その app-server が**同じ cwd の別のスレッド**を読み込んでいない（`/new`・`/resume` したスレッドは読み込まれたまま残る。
 *    同じ worktree の別の TUI のスレッドでも曖昧になるので当てない）
 * 4. ペインのスクロールバックに `codex resume <その id>`（`/new`・`/resume` で離れたときに出る）が無い
 *
 * 引数付きの `codex "…"` や subcommand は対話 TUI ではないので除く。`/resume` で映している会話は取りこぼす。
 */
export function rolloutSessionAtStart(
  env: NodeJS.ProcessEnv = process.env,
  probe: Partial<StartProbe> = {},
): (pid: number, cwd: string, pane: string) => Promise<string> {
  const root = codexSessionsDir(env)
  const markers = join(dirname(root), 'tui-thread-reference-capabilities')
  const ps = probe.ps ?? runPsStart
  const holders = probe.holders ?? runHolders
  const sockets = probe.sockets ?? runUnixSockets
  const openRollouts = probe.openRollouts ?? (async (pid: number) => (await lsofPaneFiles(env)(pid)).rollouts)
  const scrollback = probe.scrollback ?? (async () => '')
  return async (pid: number, cwd: string, pane: string): Promise<string> => {
    if (!cwd) return ''
    const info = parseCodexStart(await ps(pid))
    if (!info) return ''
    const executable = info.command.split(/\s+/, 1)[0] ?? ''
    if (basename(executable) !== 'codex' || info.command !== executable) return ''

    // 1. 起動時刻と cwd と目印
    const found = new Map<string, string>()
    for (let offset = 0; offset <= START_SLACK_S; offset++) {
      const at = new Date(info.startedAt.getTime() + offset * 1000)
      const dir = join(root, `${at.getFullYear()}/${two(at.getMonth() + 1)}/${two(at.getDate())}`)
      const stamp = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}`
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.startsWith(`rollout-${stamp}-`) || !name.endsWith('.jsonl')) continue
        const path = join(dir, name)
        const parsed = parseRolloutHead(await head(path), UUID.exec(name)?.[1] ?? '')
        if (parsed.cwd !== cwd || !parsed.session) continue
        try {
          await stat(join(markers, parsed.session))
        } catch {
          continue // TUI が作ったスレッドではない（exec・app-server から始めたものなど）
        }
        found.set(parsed.session, path)
      }
    }
    if (found.size !== 1) return ''
    const [session, path] = [...found][0]!

    // 2. その rollout を開いている app-server の客か
    const mine = await sockets(pid)
    if (!mine) return ''
    let server = 0
    for (const holder of await holders(path)) {
      if (holder !== pid && isClientOf(mine, await sockets(holder))) {
        server = holder
        break
      }
    }
    if (!server) return ''

    // 3. その app-server が同じ cwd の別のスレッドを読み込んでいないか
    for (const other of await openRollouts(server)) {
      if (other === path) continue
      const parsed = parseRolloutHead(await head(other), UUID.exec(basename(other))?.[1] ?? '')
      if (parsed.session !== session && (!parsed.cwd || parsed.cwd === cwd)) return ''
    }

    // 4. そのスレッドから離れた印がスクロールバックに無いか
    if ((await scrollback(pane)).includes(`codex resume ${session}`)) return ''
    return session
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
 * **開いている rollout** からセッション ID を引く（#429）。新しいファイル名の順に見て最初に取れたものを返す。
 * レビューの子スレッド（#403）も同時に開いていることがあるが、`parseRolloutHead()` が `session_meta` を
 * 先に見るのでどちらからでも親のセッションに落ちる。1 つも開いていなければ空（**当てない**）
 */
export async function rolloutSession(paths: readonly string[]): Promise<string> {
  for (const path of [...paths].sort((a, b) => b.localeCompare(a))) {
    const parsed = parseRolloutHead(await head(path), UUID.exec(path)?.[1] ?? '')
    if (parsed.session) return parsed.session
  }
  return ''
}

/**
 * tmux のペインで動いている Codex を数える。**行は見ない**ので、記録が 1 本も無いセッションも拾える。
 *
 * ペインの子孫に `codex` がいるかは `ps` のコマンド名で見て、セッション ID は open fd → 開始秒で引く。
 * 結果は `CODEX_PANES_TTL_MS` 覚える（3 秒のポーリングで `ps` / `lsof` / rollout の走査を起こさない）
 */
export class CodexPanes implements CodexPaneSource {
  private cache: { at: number; panes: PaneCodex[] } | null = null
  private scanning: Promise<PaneCodex[]> | null = null
  private readonly tmux: Tmux
  private readonly ps: PsFn
  private readonly openOf: (pid: number) => Promise<PaneFiles>
  private readonly sessionAtStart: (pid: number, cwd: string, pane: string) => Promise<string>
  private readonly now: () => number

  constructor(deps: CodexPaneDeps) {
    this.tmux = deps.tmux
    this.ps = deps.ps ?? realPsCommands
    this.openOf = deps.openOf ?? lsofPaneFiles(deps.env ?? process.env)
    this.sessionAtStart =
      deps.sessionAtStart ??
      rolloutSessionAtStart(deps.env ?? process.env, {
        openRollouts: async (pid) => (await this.openOf(pid)).rollouts,
        // 離れた印（`codex resume <id>`）を探すだけ。history-limit を超えた分は流れているので 3 の補い
        scrollback: (pane) => this.tmux.run(['capture-pane', '-p', '-J', '-S', '-3000', '-t', pane]).catch(() => ''),
      })
    this.now = deps.now ?? Date.now
  }

  /** 前回の結果。TTL が切れていてもそのまま（走査は起こさない） */
  last(): PaneCodex[] {
    return this.cache?.panes ?? []
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
          const { cwd, rollouts } = await this.openOf(row.pid)
          const opened = await rolloutSession(rollouts)
          const session = opened || (await this.sessionAtStart(row.pid, cwd, shell.pane))
          panes.push({ pane: shell.pane, pid: row.pid, cwd, session })
        }
      }
    } catch {
      // tmux が無い・ps が読めないときは「1 つも開いていない」ではなく**前の結果を捨てない**。
      // **失敗も TTL ぶん覚える**（#435。覚えないと、tmux の無いマシンでは cache が一度も埋まらず、
      // 3 秒のポーリングで応答を組むたびに `tmux list-panes` を起こし直していた）
      const kept = this.cache?.panes ?? []
      this.cache = { at: this.now(), panes: kept }
      return kept
    }
    this.cache = { at: this.now(), panes }
    return panes
  }
}
