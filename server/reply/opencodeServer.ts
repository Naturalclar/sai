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
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { homedir } from 'node:os'
import { opencodeModels } from '../../shared/models.ts'
import { parsePermissions } from '../../shared/opencodePermissions.ts'
import type { OpencodePermission } from '../../shared/opencodePermissions.ts'
import { opencodeSkills } from '../../shared/skills.ts'
import { opencodeTodos } from '../../shared/todos.ts'
import { settledByRow } from '../../shared/turnSettled.ts'
import { childEnv } from './runner.ts'
import type { Skill } from '../../shared/skills.ts'
import type { Replying, ReplyingMap, SessionTodo } from '../../shared/types.ts'

/** サーバが立ち上がるのを待つ上限 */
export const OPENCODE_SERVE_WAIT_MS = 20_000
/** SAI が起こした `opencode serve` の居場所・鍵・回しているターンを残すファイル（feed dir の中。#440） */
export const OPENCODE_SERVE_FILE = 'opencode-serve.json'
/** `opencode serve` の出力の置き場（feed dir の中。pipe にしない理由は `spawnServe()`） */
export const OPENCODE_SERVE_LOG = 'opencode-serve.log'

/** `OpencodeServer` を立て直しをまたいで使うための置き場（#440）。渡さなければ今までどおり SAI と一緒に落ちる */
export interface OpencodeServeState {
  /** 居場所・鍵・回しているターン（`OPENCODE_SERVE_FILE`） */
  statePath: string
  /** 出力の置き場（`OPENCODE_SERVE_LOG`） */
  logPath: string
  /** 生きているか（テストが差し替える） */
  alive?: (pid: number) => boolean
  /** 落とす（テストが差し替える。自分のプロセスを落とさないように） */
  kill?: (pid: number) => void
}

interface PersistedServe {
  pid: number
  url: string
  password: string
  /** 回しているターン（エンティティID → 画面に出す処理中と、OpenCode のセッションID） */
  turns: Record<string, { since: string; text: string; session: string }>
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 保留を 1 回引いた結果。**引けたか（`ok`）も返す**（#422。引けないことと「保留が無い」を混ぜない） */
export interface OpencodePendingResult {
  ok: boolean
  list: OpencodePermission[]
}

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
  /** 返信で選べるモデル（#394。`provider/model`）。`cwd` ごとに設定が違うので渡す */
  models(cwd: string): Promise<string[]>
  /**
   * そのセッションの段取りとサブセッションの数（#397）。**すでにサーバが立っているときだけ**聞く
   * （段取りを見るために `opencode serve` を起こさない）。立っていなければ空
   */
  todos(session: string): Promise<{ todos: SessionTodo[]; children: number }>
  /**
   * 新しいセッションを作って、その id（`ses_…`）を返す（#452。`POST /session?directory=<cwd>`）。
   *
   * **ターンを回す前に id が決まる**ので、Codex の `thread/start`（#401）・Claude の `--session-id` と同じく、
   * 最初の行が届く前にエンティティID が決まる。**一発の `opencode run` では始めない**:
   * run は許可を人に聞かずその場で自動 reject するので（実測: `permission.asked` と `permission.replied` が同じ秒）、
   * 外を触ろうとしただけでターンが丸ごと無駄になり、#421 の「画面から答える」も当たらない
   */
  startSession?(cwd: string): Promise<string>
  /** 行が届いたターンを終わりにする（#375 と同じ判定）。終わった id を返す（預かりを回すのに使う） */
  settle(lastTurn: (id: string) => string | undefined): string[]
  /**
   * SAI が回しているターンを止める（#392。`POST /session/<id>/abort`）。止めたら true で、こちらの「処理中」からも外す。
   *
   * **`abort` の返り値は当てにしない**（1.18.30 で実測: 回っていないセッションにも、知らないセッションにも `true` が返る）ので、
   * **止めてよいかは SAI が回しているか（`running()`）で決める**。回していなければ投げずに false。
   * 止めると 0.2 秒ほどで返り、`/session/status` から消え、最後のメッセージに `MessageAbortedError` が付き、
   * プラグインの `session.idle` で**本文の空の行が 1 本**書かれる（実測）。**止められるのは SAI が起こしたサーバが
   * 回しているターンだけ**（端末の TUI や人が立てた別のサーバは URL も鍵も知らないので触れない。#421 / Codex の #384 と同じ線引き）。
   * 偽物は持たなくてよい（持たなければ OpenCode には止めるボタンが出ない）
   */
  abort?(id: string): Promise<boolean>
  /**
   * いま答えを待っている許可（#421。`GET /permission?directory=<セッションの cwd>`）。
   *
   * **`directory` が要る**（`/command`・`/config/providers` と同じ。#393 / #394）。サーバは homedir で動いているので、
   * 渡さないと**空が返る**（実機で確認: 保留が 1 件あるのに `directory` 無しでは `[]`）。渡すディレクトリは呼ぶ側が決める。
   * **立っているサーバにしか聞かない**（保留を見るためだけに `opencode serve` を起こさない。
   * 立っていなければ空で、画面は今までどおり記録の待ちの行だけを出す）。
   * 偽物は持たなくてよい（持たなければ許可のバブルが出ないだけ）
   */
  permissions?(dirs: readonly string[]): Promise<OpencodePendingResult>
  /**
   * その許可に答える（#421。`POST /session/<id>/permissions/<permissionId>`）。答えられたら true。
   * **答えられるのは SAI が起こしたサーバが持っている保留だけ**（端末の TUI や人が立てた別のサーバは
   * URL も鍵も知らないので触れない。Codex の `turn/interrupt` と同じ線引き）
   */
  answerPermission?(sessionId: string, permissionId: string, response: 'once' | 'reject'): Promise<boolean>
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

/** `opencode serve` の鍵（`OPENCODE_SERVER_PASSWORD`）から Basic 認証のヘッダを作る */
function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
}

/** 起動したサーバが stdout に出す行から待ち受け先を取る（`opencode server listening on http://127.0.0.1:52341`） */
export function listeningUrl(line: string): string {
  return /listening on (http:\/\/\S+)/.exec(line)?.[1] ?? ''
}

export class OpencodeServer implements OpencodeApp {
  private child: ChildProcess | null = null
  private starting: Promise<{ url: string; auth: string }> | null = null
  private ready: { url: string; auth: string } | null = null
  /** `stop()` を呼んだ（SAI が終わるところ）。以後は `serve()` が起こさない */
  private disposed = false
  private readonly active = new Map<string, Replying>()
  /** 回しているターンの OpenCode のセッションID（`ses_…`）。止めるとき（#392）に要る */
  private readonly sessions = new Map<string, string>()
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  /** サーバの起こし方。テストでは**本物の HTTP サーバ**を指す関数を渡す（`opencode` のバイナリに触らない） */
  private readonly serveFn: (() => Promise<{ url: string; auth: string }>) | undefined
  /** 立て直しをまたぐための置き場（#440）。無ければ SAI と一緒に落ちる（#457 のまま） */
  private readonly state: OpencodeServeState | undefined
  /** 前のサーバが残した `opencode serve` を引き取ったときの pid（自分の子ではないので `child` は無い） */
  private adoptedPid = 0
  /** いまの `opencode serve` の鍵（残すファイルに書く。`ready.auth` からは戻せないので別に持つ） */
  private password = ''

  constructor(fetchFn: typeof fetch = fetch, now: () => number = Date.now, serveFn?: () => Promise<{ url: string; auth: string }>, state?: OpencodeServeState) {
    this.fetchFn = fetchFn
    this.now = now
    this.serveFn = serveFn
    this.state = state
    this.adopt()
  }

  private alive(pid: number): boolean {
    return (this.state?.alive ?? isAlive)(pid)
  }

  /** 立っているか。自分の子なら exit していないか、引き取ったものなら pid が生きているか */
  private up(): boolean {
    if (this.child) return this.child.exitCode === null
    return this.adoptedPid > 0 && this.alive(this.adoptedPid)
  }

  /**
   * 前のサーバが残した `opencode serve` を引き取る（#440）。pid が生きていれば、居場所と鍵をそのまま使い、
   * 回していたターンも処理中として戻す（行が届けば `settle()` が片付ける）。死んでいればファイルを消す
   */
  private adopt(): void {
    if (!this.state) return
    let raw: Partial<PersistedServe> | null = null
    try {
      raw = JSON.parse(readFileSync(this.state.statePath, 'utf-8')) as Partial<PersistedServe>
    } catch {
      return
    }
    const ok = raw && typeof raw.pid === 'number' && raw.pid > 0 && typeof raw.url === 'string' && typeof raw.password === 'string'
    if (!ok || !this.alive(raw!.pid!)) {
      this.forget()
      return
    }
    this.adoptedPid = raw!.pid!
    this.password = raw!.password!
    this.ready = { url: raw!.url!, auth: basicAuth(this.password) }
    for (const [id, t] of Object.entries(raw!.turns ?? {})) {
      if (typeof t?.since !== 'string' || typeof t.text !== 'string' || typeof t.session !== 'string') continue
      this.active.set(id, { since: t.since, text: t.text, interruptible: true })
      this.sessions.set(id, t.session)
    }
  }

  /** いまの居場所・鍵・回しているターンを書く（tmp → rename。鍵が入るので 0600）。立っていなければ何もしない */
  private persist(): void {
    if (!this.state || !this.ready || !this.up()) return
    const pid = this.child?.pid ?? this.adoptedPid
    if (!pid) return
    const turns: PersistedServe['turns'] = {}
    for (const [id, r] of this.active) {
      const session = this.sessions.get(id)
      if (session) turns[id] = { since: r.since, text: r.text, session }
    }
    const body: PersistedServe = { pid, url: this.ready.url, password: this.password, turns }
    try {
      mkdirSync(dirname(this.state.statePath), { recursive: true })
      const tmp = `${this.state.statePath}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.state.statePath)
    } catch {
      // 書けなければ立て直しで引き取れないだけ（#440 より前と同じ）
    }
  }

  /** 残したファイルを消す（落とした・落ちた） */
  private forget(): void {
    if (!this.state) return
    try {
      rmSync(this.state.statePath, { force: true })
    } catch {
      // 次の起動で pid が死んでいれば消える
    }
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
        this.sessions.delete(id)
        done.push(id)
      }
    }
    if (done.length > 0) this.persist()
    return done
  }

  /**
   * 新しいセッションを作る（#452）。`POST /session?directory=<cwd>` が **id を持った JSON を返す**
   * （実測 1.18.30: `{"id":"ses_…","directory":"…","title":"…"}`）。ここで作るだけでは行は 1 本も書かれない
   * （記録はプラグインの `session.idle` 起点なので、ターンを回して初めて一覧に出る）
   */
  async startSession(cwd: string): Promise<string> {
    const { url, auth } = await this.serve()
    const res = await this.fetchFn(`${url}/session?directory=${encodeURIComponent(cwd)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: '{}',
    })
    if (!res.ok) throw new Error(`opencode serve が ${res.status} を返しました: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const body = (await res.json().catch(() => null)) as { id?: unknown } | null
    const session = typeof body?.id === 'string' ? body.id : ''
    if (!session) throw new Error('opencode serve がセッションIDを返しませんでした')
    return session
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
    // `prompt_async` が 204 を返した時点でターンは回っているので、すぐ止められる（#392。Codex と違って turnId を待たない）
    this.active.set(input.id, { since: new Date(this.now()).toISOString(), text: input.text, interruptible: true })
    this.sessions.set(input.id, input.session)
    this.persist()
  }

  async abort(id: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session || !this.active.has(id)) return false
    // 止めるためだけにサーバは起こさない。**立っていない（死んだ・落とした）なら、そのターンももう回っていない**ので、
    // 処理中から外して止まった扱いにする（false を返すと「起動した直後なので止められない」の 409 になり、
    // 効かない「止める」と「処理中」が残り続ける。#488 のレビュー）
    const live = await this.live().catch(() => null)
    if (!live) {
      this.active.delete(id)
      this.sessions.delete(id)
      this.persist()
      return true
    }
    const res = await this.fetchFn(`${live.url}/session/${encodeURIComponent(session)}/abort`, {
      method: 'POST',
      headers: { authorization: live.auth },
    })
    if (!res.ok) throw new Error(`opencode serve が ${res.status} を返しました: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    // 行（本文の空の session.idle）が届くのを待たずに片付ける（Codex の clearThread() と同じ。届かなくても「処理中」を残さない）
    this.active.delete(id)
    this.sessions.delete(id)
    this.persist()
    return true
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

  /**
   * 返信のモデル候補（#394）。`GET /config/providers?directory=<cwd>` の**設定済みの provider**から作る。
   * `/api/model` の 93 件ではなく**その人が実際に使えるもの**にする（数の多さより当たりやすさ）。
   * `directory` を渡すと、その worktree の `opencode.json` で足した provider まで出る（実機で確認）
   */
  async models(cwd: string): Promise<string[]> {
    const { url, auth } = await this.serve()
    const res = await this.fetchFn(`${url}/config/providers?directory=${encodeURIComponent(cwd)}`, { headers: { authorization: auth } })
    if (!res.ok) throw new Error(`opencode serve が ${res.status} を返しました`)
    return opencodeModels(await res.json())
  }

  /**
   * いま答えを待っている許可（#421）。**立っているサーバにしか聞かない**ので、返信を 1 度も回していなければ
   * ここでサーバが起きることはない（3 秒のポーリングのついでに呼ばれる）。読めなければ空
   */
  async permissions(dirs: readonly string[]): Promise<OpencodePendingResult> {
    const live = await this.live()
    // **立っていなければ `ok: false`**（「保留が無い」と区別が付かないと、待ちを畳んでよいか決められない。#422）
    if (!live) return { ok: false, list: [] }
    const out: OpencodePermission[] = []
    const seen = new Set<string>()
    let ok = true
    // ディレクトリごとに 1 本。普段は 0〜1 件（SAI が回している OpenCode のターンの分だけ）
    for (const dir of dirs) {
      try {
        const res = await this.fetchFn(`${live.url}/permission?directory=${encodeURIComponent(dir)}`, { headers: { authorization: live.auth } })
        if (!res.ok) {
          ok = false
          continue
        }
        for (const p of parsePermissions(await res.json())) {
          if (seen.has(p.id)) continue
          seen.add(p.id)
          out.push(p)
        }
      } catch {
        // 読めなければその分は諦める（画面は記録の待ちの行だけになり、待ちも畳まない）
        ok = false
      }
    }
    return { ok, list: out }
  }

  /** その許可に答える（#421）。`once` で許可、`reject` で拒否。答えられたら true */
  async answerPermission(sessionId: string, permissionId: string, response: 'once' | 'reject'): Promise<boolean> {
    const live = await this.live()
    if (!live) return false
    try {
      const res = await this.fetchFn(`${live.url}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: live.auth },
        body: JSON.stringify({ response }),
      })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * **立っているサーバ。無ければ null で、起こさない**（`serve()` との違いはここだけ）。
   * 許可を見るためだけに `opencode serve` を立てるのは本末転倒なので、返信を 1 度も回していないうちは何もしない。
   * 差し替え（`serveFn`）はテストが本物の HTTP サーバを指しているので、そのまま引く
   */
  private async live(): Promise<{ url: string; auth: string } | null> {
    if (this.serveFn) return this.serveFn()
    return this.ready && this.up() ? this.ready : null
  }

  /**
   * 段取り（`GET /session/<id>/todo`）とサブセッションの数（`GET /session/<id>/children`）。#397。
   *
   * **立っているサーバにだけ聞く。** ここは処理中の 3 秒ごとのポーリングから呼ばれるので、
   * 段取りを見るためだけに `opencode serve` を起こさない（`/` の候補と同じ考え方。#393）。
   * 片方が落ちてももう片方は返す（どちらも「無い」で困らない）
   */
  async todos(session: string): Promise<{ todos: SessionTodo[]; children: number }> {
    const up = await this.live()
    if (!up) return { todos: [], children: 0 }
    const get = async (path: string): Promise<unknown> => {
      const res = await this.fetchFn(`${up.url}/session/${encodeURIComponent(session)}/${path}`, { headers: { authorization: up.auth } })
      if (!res.ok) throw new Error(`opencode serve が ${res.status} を返しました`)
      return res.json()
    }
    const [todos, children] = await Promise.all([
      get('todo').then(opencodeTodos).catch(() => [] as SessionTodo[]),
      get('children').then((d) => (Array.isArray(d) ? d.length : 0)).catch(() => 0),
    ])
    return { todos, children }
  }

  /**
   * 落として、**以後は起こさない**（#457）。SAI が終わるときに `createApp()` の `dispose()` から呼ばれる。
   * C-c のあとも接続が閉じるまで（最大 `FORCE_EXIT_MS`）サーバは動いていて、その間に処理中のリクエスト
   * （`/skills` / `/models`）や返信の子の終わり（`drain()` → `start()`）が `serve()` を呼ぶと、
   * 新しい `opencode serve` が起きて、SAI が終わった直後に ppid 1 の孤児になる（レビューの指摘）
   */
  stop(): void {
    this.disposed = true
    // **ターンを回している間は落とさずに渡す**（#440）。次の SAI が `opencode-serve.json` から引き取り、ターンはそのまま続く
    // （前は立て直すたびにターンが途中で切れた）。回していなければ今までどおり落とす（#457。落とさないと立て直すたびに
    // 孤児が 1 本ずつ増える）。渡したものも、次の SAI が引き取ったあとで回していないときに止めれば落ちるので、溜まらない
    if (this.state && this.active.size > 0 && this.up()) {
      this.persist()
      this.child?.unref()
    } else {
      if (this.child) this.child.kill()
      else if (this.adoptedPid > 0 && this.alive(this.adoptedPid)) (this.state?.kill ?? ((pid: number) => process.kill(pid)))(this.adoptedPid)
      this.forget()
    }
    this.child = null
    this.adoptedPid = 0
    this.ready = null
    this.starting = null
  }

  /** 立っていれば使い回す。落ちていたら起こし直す */
  private async serve(): Promise<{ url: string; auth: string }> {
    // 止めたあとは起こさない（起こすと、終わりかけの SAI の子として孤児になる。#457）
    if (this.disposed) throw new Error('SAI を止めているところなので、opencode serve は起こしません')
    if (this.serveFn) return this.serveFn()
    if (this.ready && this.up()) return this.ready
    this.ready = null
    this.adoptedPid = 0
    this.starting ??= this.spawnServe().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private spawnServe(): Promise<{ url: string; auth: string }> {
    // **鍵を付ける**（ループバックでも、鍵が無いと同じマシンの別のプロセスがエージェントを動かせてしまう）。
    // mDNS（`--mdns`）と `--cors` は使わない（「SAI は外に出さない」）
    const password = randomUUID()
    const auth = basicAuth(password)
    // 立て直しをまたぐときは（#440）、**別の pgid で起こし（C-c の SIGINT を受けない）、出力はファイルに書かせる**。
    // pipe のままだと、SAI が落ちたあとに書いた瞬間に EPIPE で死ぬ（返信の子の stdout を reply.log の fd にしているのと同じ理由）。
    // 待ち受け先はそのファイルの、起こしたあとに書かれた分から読む
    const logPath = this.state?.logPath ?? ''
    let logStart = 0
    let logFd: number | null = null
    if (logPath) {
      try {
        mkdirSync(dirname(logPath), { recursive: true })
        logFd = openSync(logPath, 'a', 0o600)
        logStart = statSync(logPath).size
      } catch {
        logFd = null
      }
    }
    // cwd は worktree に縛らない（セッションの cwd はセッション側で決まる）
    const child = spawn('opencode', ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      cwd: homedir(),
      env: { ...childEnv(process.env), OPENCODE_SERVER_PASSWORD: password },
      stdio: logFd !== null ? ['ignore', logFd, logFd] : ['ignore', 'pipe', 'pipe'],
      detached: logFd !== null,
    })
    if (logFd !== null) closeSync(logFd) // 子が持っているので、こちらは閉じる
    this.child = child
    this.password = password
    return new Promise((resolve, reject) => {
      // 立ち上がる前に落ちた / 出力が来ないときだけ投げる。立ち上がったあとの exit は次の返信で起こし直す
      let settled = false
      const timer = setTimeout(() => {
        child.kill()
        done(new Error(`opencode serve が ${OPENCODE_SERVE_WAIT_MS / 1000} 秒で立ち上がりませんでした`))
      }, OPENCODE_SERVE_WAIT_MS)
      let poll: ReturnType<typeof setInterval> | null = null
      const done = (err: Error | null, url = '') => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (poll) clearInterval(poll)
        if (err) reject(err)
        else {
          this.ready = { url, auth }
          this.persist() // 立った時点で書く（SAI が落ちても、次の SAI が引き取れる）
          resolve(this.ready)
        }
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        const url = listeningUrl(chunk.toString())
        if (url) done(null, url)
      })
      if (logPath && !child.stdout) {
        poll = setInterval(() => {
          let text = ''
          try {
            text = readFileSync(logPath, 'utf-8').slice(logStart)
          } catch {
            return
          }
          const url = listeningUrl(text)
          if (url) done(null, url)
        }, 100)
      }
      child.on('error', (err) => done(err))
      child.on('exit', (code) => {
        // 渡したあと（`stop()` で `child` を外した）の exit は、次の SAI の持ち物なので触らない
        if (this.child !== child) return
        this.child = null
        this.ready = null
        this.forget()
        done(new Error(`opencode serve が終了しました（終了コード ${code}）`))
      })
    })
  }
}
