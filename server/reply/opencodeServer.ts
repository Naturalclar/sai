// OpenCode への返信を、`opencode run -s`（ワンショット）ではなく **長寿命の `opencode serve` の HTTP** に送る（#382）。
// Codex の app-server（`codexAppServer.ts`）と同じ形で、SAI が 1 つだけ起こして使い回す。
//
// 実機（1.18.30）で確かめたこと:
// - **サーバでもプラグインは動く**（`~/.config/opencode/plugin/sai.js`）。返信したターンは今までどおり行として記録される
// - **セッションは ID だけで引ける**。`/tmp/a` で起こしたサーバから、別の worktree のセッションに送っても
//   **そのセッションの cwd で走る**（行の `cwd` で確認）。だから **worktree ごとにサーバを起こさなくてよい**
// - `OPENCODE_SERVER_PASSWORD` を渡すと、鍵の無いリクエストは `/doc` も含めて 401 になる
// - `POST /session/<id>/prompt_async` は 204 を返してすぐ戻り、ターンはサーバ側で走る。
//   `model`（`{providerID, modelID}`）と `parts`（text / file）を**ターンごとに**渡せるので、今までの `-m` / `-f` と同じ
// - 許可（read / bash）は**聞かれずに通った**。`opencode run` が許可を自動 reject して本文なしで終わる（#273）のに当たらない。
//   ただし設定で `ask` にしている人は答え待ちで止まる（答える口は #382 の 2 段目）
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import { homedir } from 'node:os'
import { opencodeSkills } from '../../shared/skills.ts'
import { settledByRow } from '../../shared/turnSettled.ts'
import { childEnv } from './runner.ts'
import type { Skill } from '../../shared/skills.ts'
import type { Replying, ReplyingMap } from '../../shared/types.ts'

/** サーバが立ち上がるのを待つ上限 */
export const OPENCODE_SERVE_WAIT_MS = 20_000

/** 送るぶん。`model` は SAI のメタと同じ `provider/model` の形 */
export interface OpencodeTurnInput {
  /** エンティティID（`<session>@<repo>`）。処理中の見出しに使う */
  id: string
  /** OpenCode のセッションID（`ses_…`） */
  session: string
  text: string
  model?: string | undefined
  attachments?: readonly string[] | undefined
}

export interface OpencodeApp {
  running(id: string): boolean
  replying(): ReplyingMap
  start(input: OpencodeTurnInput): Promise<void>
  /**
   * そのセッションの `/` の候補（#393）。`cwd` を渡すので、**そのリポジトリのスキル**まで出る
   * （サーバ自身は homedir で動いているため、渡さないとサーバ側の顔ぶれになる）
   */
  skills(cwd: string): Promise<Skill[]>
  /** 行が届いたターンを終わりにする（#375 と同じ判定）。終わった id を返す（預かりを回すのに使う） */
  settle(lastTurn: (id: string) => string | undefined): string[]
  stop(): void
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * `POST /session/<id>/prompt_async` に送る中身。**純粋関数**なのでテストで形だけ確かめられる。
 * モデルは `provider/model` を**最初の `/` で割る**（`ollama/qwen3:8b` → `{ollama, qwen3:8b}`。モデル名に `/` が入ることがある）
 */
export function promptBody(input: OpencodeTurnInput): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [{ type: 'text', text: input.text }]
  for (const path of input.attachments ?? []) {
    parts.push({ type: 'file', mime: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream', filename: basename(path), url: `file://${path}` })
  }
  const slash = (input.model ?? '').indexOf('/')
  const model = slash > 0 ? { providerID: input.model!.slice(0, slash), modelID: input.model!.slice(slash + 1) } : undefined
  return { ...(model ? { model } : {}), parts }
}

/** 起動したサーバが stdout に出す行から待ち受け先を取る（`opencode server listening on http://127.0.0.1:52341`） */
export function listeningUrl(line: string): string {
  return /listening on (http:\/\/\S+)/.exec(line)?.[1] ?? ''
}

export class OpencodeServer implements OpencodeApp {
  private child: ChildProcess | null = null
  private starting: Promise<{ url: string; auth: string }> | null = null
  private ready: { url: string; auth: string } | null = null
  private readonly active = new Map<string, Replying>()
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  /** サーバの起こし方。テストでは**本物の HTTP サーバ**を指す関数を渡す（`opencode` のバイナリに触らない） */
  private readonly serveFn: (() => Promise<{ url: string; auth: string }>) | undefined

  constructor(fetchFn: typeof fetch = fetch, now: () => number = Date.now, serveFn?: () => Promise<{ url: string; auth: string }>) {
    this.fetchFn = fetchFn
    this.now = now
    this.serveFn = serveFn
  }

  running(id: string): boolean {
    return this.active.has(id)
  }

  replying(): ReplyingMap {
    return Object.fromEntries(this.active)
  }

  settle(lastTurn: (id: string) => string | undefined): string[] {
    const done: string[] = []
    for (const [id, entry] of this.active) {
      if (settledByRow(entry.since, lastTurn(id))) {
        this.active.delete(id)
        done.push(id)
      }
    }
    return done
  }

  async start(input: OpencodeTurnInput): Promise<void> {
    const { url, auth } = await this.serve()
    const res = await this.fetchFn(`${url}/session/${encodeURIComponent(input.session)}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify(promptBody(input)),
    })
    // 204 が正。404 は「そのセッションをサーバが知らない」なので、取り違えないよう本文を添えて投げる
    if (!res.ok) throw new Error(`opencode serve が ${res.status} を返しました: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    this.active.set(input.id, { since: new Date(this.now()).toISOString(), text: input.text })
  }

  /**
   * `/` の候補。`GET /command?directory=<cwd>` **1 本だけ**で、スキルもスラッシュコマンドも返る（#393）。
   * サーバが立っていなければここで起こす（`/` を打った最初の 1 回だけ待たされる）。
   * 取れなければ throw して、呼び出し側（`app.ts`）が今までどおり空にする
   */
  async skills(cwd: string): Promise<Skill[]> {
    const { url, auth } = await this.serve()
    const res = await this.fetchFn(`${url}/command?directory=${encodeURIComponent(cwd)}`, { headers: { authorization: auth } })
    if (!res.ok) throw new Error(`opencode serve が ${res.status} を返しました`)
    return opencodeSkills(await res.json())
  }

  stop(): void {
    this.child?.kill()
    this.child = null
    this.ready = null
    this.starting = null
  }

  /** 立っていれば使い回す。落ちていたら起こし直す */
  private async serve(): Promise<{ url: string; auth: string }> {
    if (this.serveFn) return this.serveFn()
    if (this.ready && this.child && this.child.exitCode === null) return this.ready
    this.ready = null
    this.starting ??= this.spawnServe().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private spawnServe(): Promise<{ url: string; auth: string }> {
    // **鍵を付ける**（ループバックでも、鍵が無いと同じマシンの別のプロセスがエージェントを動かせてしまう）。
    // mDNS（`--mdns`）と `--cors` は使わない（「SAI は外に出さない」）
    const password = randomUUID()
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
    // cwd は worktree に縛らない（セッションの cwd はセッション側で決まる）
    const child = spawn('opencode', ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      cwd: homedir(),
      env: { ...childEnv(process.env), OPENCODE_SERVER_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    return new Promise((resolve, reject) => {
      // 立ち上がる前に落ちた / 出力が来ないときだけ投げる。立ち上がったあとの exit は次の返信で起こし直す
      let settled = false
      const timer = setTimeout(() => {
        child.kill()
        done(new Error(`opencode serve が ${OPENCODE_SERVE_WAIT_MS / 1000} 秒で立ち上がりませんでした`))
      }, OPENCODE_SERVE_WAIT_MS)
      const done = (err: Error | null, url = '') => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) reject(err)
        else {
          this.ready = { url, auth }
          resolve(this.ready)
        }
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        const url = listeningUrl(chunk.toString())
        if (url) done(null, url)
      })
      child.on('error', (err) => done(err))
      child.on('exit', (code) => {
        this.child = null
        this.ready = null
        done(new Error(`opencode serve が終了しました（終了コード ${code}）`))
      })
    })
  }
}
