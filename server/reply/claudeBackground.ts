// `claude --bg` で新しいセッションを始める・止める（#462）。
//
// 始めたセッションは Claude Code のデーモンの中で動くので、端末で `claude attach <短い ID>` すれば TUI として開ける
// （SAI の `-p` で始めたセッションは、終わったあとに `claude --resume` で開き直すしかなかった）。
//
// 叩くのは `claude --bg …`（`backgroundSessionCommand()`）・`claude agents --json --all --cwd <cwd>`・`claude stop <短い ID>` の 3 形と、
// attach している端末を探す `ps -axo command=` だけ。
// 実行ファイルはサーバの PATH の `claude`（#288）。テストは偽物を渡す
import { execFile } from 'node:child_process'
import { parseAgents } from '../local/claudeAgents.ts'
import { childEnv, type ReplyCommand } from './runner.ts'

/** `claude --bg` が返るまで。実測 0.6 秒（デーモンを起こすところからでも数秒） */
export const BACKGROUND_START_TIMEOUT_MS = 30_000
/** 始めた直後の `claude agents` に出てくるまで待つ回数と間隔（実測では 1 回目で出る） */
const LOOKUP_TRIES = 10
const LOOKUP_INTERVAL_MS = 300

/** `claude --bg` は始まったが、UUID を引けなかった。セッションは動いているので、短い ID を持って返す */
export class BackgroundLookupError extends Error {
  readonly short: string
  constructor(short: string) {
    super(`バックグラウンドでは始まりましたが、ID を引けませんでした。端末で claude attach ${short} して開けます（もう一度始めると二重になります）`)
    this.short = short
  }
}

export interface BackgroundStarted {
  /** `claude attach` / `stop` に渡す短い ID */
  short: string
  /** 記録の `session`（フックの `session_id`）になる UUID */
  sessionId: string
}

/** 始める・止める口。テストでは差し替える */
export interface BackgroundSessions {
  start(cmd: ReplyCommand): Promise<BackgroundStarted>
  /**
   * 生きている `claude --bg` のセッションを止める（会話は残るので `claude attach` や `--resume` で続けられる）。
   * **attach している端末をその場で閉じる**（2026-09-24 に実測: `Session … has exited.`）ので、
   * 呼ぶ前に必ず `attached()` で誰も開いていないことを確かめる
   */
  stop(short: string, cwd: string): Promise<void>
  /**
   * そのセッションを `claude attach` で開いている端末があるか（#462）。
   * **分からないとき（`ps` が読めない）は true**——止めない側に倒す（人の画面を落とすよりは、預かって待つ方がよい）
   */
  attached(short: string, sessionId: string): Promise<boolean>
}

/**
 * `ps -axo command=` の出力から、そのセッションに attach している端末を探す（純粋関数）。
 *
 * **argv の並びで厳密に見る**: `claude` の後ろに `attach` と ID が**続けて**並ぶ行だけを数える。
 * 素朴に「`attach` を含む」で探すと、SAI 自身の `claude -p`（`--mcp-config` の中に `attachments` がある）に当たる（実測）。
 * ID は `claude --bg` が出す短い ID のほかに、UUID 全体やその頭（6 文字以上）でも attach できるので、それも数える
 */
export function attachedIn(psOutput: string, short: string, sessionId: string): boolean {
  const matches = (id: string) => id === short || id === sessionId || (id.length >= 6 && sessionId.startsWith(id))
  for (const line of psOutput.split('\n')) {
    const argv = line.trim().split(/\s+/)
    const at = argv.findIndex((word) => word === 'claude' || word.endsWith('/claude'))
    if (at < 0) continue
    if (argv[at + 1] === 'attach' && argv[at + 2] !== undefined && matches(argv[at + 2]!)) return true
  }
  return false
}

const realPs = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'command='], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(`${stdout}`)))
  })

/**
 * `claude --bg` の出力から短い ID を取る。`backgrounded · 5738db0d` の形（2.1.276 で実測）。
 * 読めなければ空（出力の形が変わった）
 */
export function parseBackgrounded(stdout: string): string {
  return /backgrounded\s*·\s*([0-9a-f]{6,})/i.exec(stdout)?.[1] ?? ''
}

function run(bin: string, args: string[], cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, env: childEnv(), timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = `${stderr}`.trim().split('\n').slice(-3).join(' / ')
        const e = new Error(tail || err.message) as NodeJS.ErrnoException
        if ((err as NodeJS.ErrnoException).code !== undefined) e.code = (err as NodeJS.ErrnoException).code as string
        return reject(e)
      }
      resolve(`${stdout}`)
    })
  })
}

export class ClaudeBackground implements BackgroundSessions {
  readonly bin: string
  private readonly ps: () => Promise<string>
  constructor(bin: string = 'claude', ps: () => Promise<string> = realPs) {
    this.bin = bin
    this.ps = ps
  }

  async start(cmd: ReplyCommand): Promise<BackgroundStarted> {
    const out = await run(this.bin, cmd.args, cmd.cwd, BACKGROUND_START_TIMEOUT_MS)
    const short = parseBackgrounded(out)
    if (!short) throw new Error(`claude --bg の出力から ID を読めませんでした: ${out.trim().split('\n')[0] ?? ''}`)
    // `--session-id` は効かないので、UUID は `claude agents` から引く
    for (let i = 0; i < LOOKUP_TRIES; i++) {
      const agents = parseAgents(await run(this.bin, ['agents', '--json', '--all', '--cwd', cmd.cwd], cmd.cwd, 4000).catch(() => ''))
      const hit = agents?.find((a) => a.id === short || a.sessionId.startsWith(short))
      if (hit) return { short, sessionId: hit.sessionId }
      await new Promise((r) => setTimeout(r, LOOKUP_INTERVAL_MS))
    }
    // **セッションはもう動いている**ので、短い ID を添える（無いと「始められなかった」と読んで同じ指示で二重に始める）
    throw new BackgroundLookupError(short)
  }

  async stop(short: string, cwd: string): Promise<void> {
    await run(this.bin, ['stop', short], cwd, 10_000)
  }

  async attached(short: string, sessionId: string): Promise<boolean> {
    try {
      return attachedIn(await this.ps(), short, sessionId)
    } catch {
      return true // 分からないときは止めない
    }
  }
}
