// SAI のプラグイン（#209）。OpenCode のターン完了と許可待ちを feed/record.py に流す。
//
// OpenCode に Claude Code のようなフックは無く、**プラグイン**（`.opencode/plugin/` か
// `~/.config/opencode/plugin/` に置く JS/TS）でイベントを受ける。置き方は README。
//
// 依存ゼロ・素の JS。opencode 本体の中で動くので、ここで例外を投げると本体を巻き込む。
// **絶対に throw しない**（record.py が必ず exit 0 なのと同じ理由）。
//
// 環境変数:
//   SAI_HOME          このリポジトリの場所。record.py の在り処。無ければこのファイルの隣から辿る
//   AGENT_FEED_SKIP   1 なら何もしない（record.py 側と同じ）
//
// 実測（opencode 1.18.30）:
//   - `session.idle` は `properties.sessionID` **だけ**で本文を持たない
//   - 本文は `message.part.updated` の `part.type === 'text'`（`part.text` が毎回そのときの全文）
//   - 役割とモデルは `message.updated` の `properties.info`（`role` / `providerID` / `modelID` / `path.cwd`）
//   - タイトル生成の裏の呼び出しでは `session.idle` は鳴らない（人のターンの分だけ届く）
//   - `session.idle` は 1 ターンに複数回鳴ることがある（中断・再試行の後）。本文が増えていなければ流さない
//     （止めたときは同じ秒に 2 回鳴るので、状態は**送る前に**空にする。#392）
//   - **`opencode run`（非対話）は許可を聞けないので自動で reject する**（`permission.replied` の `reply: "reject"`）。
//     ツールが `state.status: "error"` で終わった時点でターンが終わり、アシスタントは本文（text パーツ）を書かない。
//     SAI の返信経路（閉じたセッションへの `opencode run -s`）はこれに当たる（#273）
//   - 同じ瞬間の `permission.asked` / `permission.replied` は、record.py が 2 つ競走するので**逆順で書かれることがある**。
//     **ここで直列にしない**: 後ろの送信が前の record.py の終了待ちで遅れ、その間に `opencode run` が終わると
//     行が消える（下の send() を detached にした理由と同じ）。run では必ず後に session.idle の行が来るので、
//     許可待ちが残り続けることは無い（#273 で確かめた）
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

/** record.py の在り処。SAI_HOME があればそれ、無ければこのファイルの隣（feed/opencode/ → feed/） */
function recordPath() {
  const home = (process.env.SAI_HOME || "").trim()
  if (home) return join(home, "feed", "record.py")
  try {
    return join(dirname(dirname(fileURLToPath(import.meta.url))), "record.py")
  } catch {
    return ""
  }
}

/** record.py が終わるのを待つ上限。これを超えたら諦めて先に進む（本体を待たせない） */
const RECORD_TIMEOUT_MS = 10000

/**
 * record.py に1行渡す。失敗しても握り潰す（本体を止めない）。
 *
 * **`detached` で切り離す。** `session.idle` は `opencode run` が終わる直前に鳴り、
 * opencode はプラグインの hook を待たずに落ちる。子のままだと record.py が書き終える前に
 * 巻き添えで死んで**行が消える**（実測。await しても直らなかった）。切り離せば init に
 * 引き取られて最後まで書く。payload は `stdin.end()` で一度に渡すので、親が先に消えても届く。
 *
 * 戻り値の Promise は「待てるなら待つ」ためのもの（TUI のように本体が生きている経路では
 * ここで終わりまで見る）。RECORD_TIMEOUT_MS で諦める。
 */
function send(payload) {
  if (process.env.AGENT_FEED_SKIP === "1") return Promise.resolve()
  const script = recordPath()
  if (!script) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, RECORD_TIMEOUT_MS)
    try {
      const child = spawn("python3", [script, "--agent", "opencode"], { stdio: ["pipe", "ignore", "ignore"], detached: true })
      child.on("error", finish)
      child.on("close", finish)
      child.stdin.on("error", () => {})
      child.stdin.end(JSON.stringify(payload))
      child.unref()
    } catch {
      finish() // 記録できないだけ。エージェントは止めない
    }
  })
}

/** 本文の上限（record.py の text と同じく、画面が困らない長さで切る） */
const FAILED_MAX = 300

/**
 * 本文の無いターンに出す「何が起きたか」の1行（#273）。そのターンで最後に失敗したツールから作る。
 * 許可の拒否（`opencode run` が自動で reject したときなど）はそう書き、それ以外は失敗のメッセージをそのまま添える。
 * 失敗したツールも無ければ空（本当に何も書かなかったターン。画面は今までどおり「(本文なし)」）
 */
/** 本文が書かれる前に人が止めたターン（#392）。#273 の「失敗して終わりました」と同じ形にそろえる */
const ABORTED_TEXT = "（本文なし）途中で止めました"

function failedText(failed) {
  if (!failed) return ""
  const tool = String(failed.tool || "ツール").trim()
  const error = String(failed.error || "").trim()
  const line = /rejected permission/i.test(error)
    ? `（本文なし）${tool} の許可が拒否されて終わりました（${error}）`
    : `（本文なし）${tool} が失敗して終わりました${error ? `: ${error}` : ""}`
  return line.slice(0, FAILED_MAX)
}

/**
 * 許可待ちの1行に出す要約。`許可待ち: external_directory: /etc/hosts` の形
 * （record.py / shared/approvals.ts と揃える。中身の規則は **`shared/opencodePermissions.ts` の
 * `opencodePermissionText()` と同じ**で、同じ入力と同じ期待文字列を両方のテストに置いてある）。
 *
 * **キーの大文字小文字は無視する**（実物は `metadata.filepath` で、`filePath` だけを見ていたころは
 * `許可待ち: external_directory` としか書けず、どのパスを聞かれているのか行に残らなかった。#421）。
 * metadata から拾えなければ `patterns`（`/etc/*` のような範囲）の1つめ
 */
function permissionText(props) {
  const p = props ?? {}
  const kind = String(p.permission || p.type || p.title || "許可").trim()
  const meta = p.metadata ?? p.args ?? p.input ?? {}
  const lower = {}
  for (const [k, v] of Object.entries(meta || {})) lower[k.toLowerCase()] = v
  let detail = ""
  for (const key of ["command", "filepath", "file_path", "path", "url", "pattern", "description", "parentdir"]) {
    const v = lower[key]
    if (typeof v === "string" && v.trim()) {
      detail = v.trim()
      break
    }
  }
  if (!detail && Array.isArray(p.patterns) && typeof p.patterns[0] === "string") detail = p.patterns[0].trim()
  const line = detail ? `${kind}: ${detail}` : kind
  return `許可待ち: ${line}`.slice(0, 300)
}

export const SaiPlugin = async ({ directory, worktree }) => {
  // セッションごとの組み立て途中。message.updated で役割とモデルを覚え、
  // message.part.updated で本文を上書きし、session.idle で1行にして流す
  const state = new Map()
  const of = (id) => {
    let s = state.get(id)
    if (!s) {
      // failed: そのターンで最後に失敗したツール（{ tool, error }）。本文が無いときの代わりに使う
      // aborted: そのターンを人が止めた（`session.error` の `MessageAbortedError`。#392）
      s = { roles: new Map(), text: "", userText: "", model: "", cwd: "", dirty: false, failed: null, aborted: false }
      state.set(id, s)
    }
    return s
  }

  return {
    event: async ({ event }) => {
      try {
        const type = event?.type
        const props = event?.properties ?? {}
        const id = props.sessionID

        if (type === "message.updated") {
          const info = props.info ?? {}
          if (!info.sessionID || !info.id) return
          const s = of(info.sessionID)
          s.roles.set(info.id, info.role)
          if (info.role === "assistant") {
            if (info.providerID && info.modelID) s.model = `${info.providerID}/${info.modelID}`
            if (info.path?.cwd) s.cwd = info.path.cwd
          }
          return
        }

        if (type === "message.part.updated") {
          const part = props.part ?? {}
          if (!part.sessionID) return
          // 失敗したツール（許可の拒否など）。本文が書かれないまま終わったターンの「何が起きたか」に使う（#273）
          if (part.type === "tool" && part.state?.status === "error") {
            const s = of(part.sessionID)
            s.failed = { tool: part.tool, error: part.state.error }
            s.dirty = true
            return
          }
          if (part.type !== "text" || typeof part.text !== "string") return
          const s = of(part.sessionID)
          // 役割はたいてい message.updated が先に来る。来ていなければ後から来る分で埋まる
          if (s.roles.get(part.messageID) === "user") s.userText = part.text
          else s.text = part.text
          s.dirty = true
          return
        }

        // 人がターンを止めた（SAI の「止める」= `POST /session/<id>/abort`、#392。TUI の Esc も同じ）。
        // 1.18.30 で実測: `session.error`（`MessageAbortedError`）→ `session.idle` → … → `session.idle` の順に届く
        if (type === "session.error") {
          if (!id || props.error?.name !== "MessageAbortedError") return
          const s = of(id)
          s.aborted = true
          s.dirty = true
          return
        }

        if (type === "session.idle") {
          if (!id) return
          const s = of(id)
          // idle は 1 ターンに複数回鳴ることがある（中断や再試行の後など。実測）。
          // 前に流してから何も増えていなければ流さない（同じ行が二重に載る）
          if (!s.dirty) return
          const row = {
            type: "session.idle",
            session_id: id,
            pid: process.pid,
            cwd: s.cwd || directory || worktree || "",
            // 本文が無ければ「何が起きたか」を出す（空のままだと画面は「(本文なし)」しか出せない）:
            // 止めたなら止めたこと（#392）、でなければ失敗したツール（#273）
            text: s.text || (s.aborted ? ABORTED_TEXT : failedText(s.failed)),
            user_text: s.userText,
            model: s.model,
          }
          // **送る前に**空にする（#392）。`send()` は record.py の終了を待つので、そのあとで空にすると、
          // その間に届いた次の idle（止めたときは同じ秒に 2 回鳴る。実測）が `dirty` の立ったままの状態を見て、
          // 同じ行（自分の入力つき）をもう 1 本書いていた。送信は今までどおり並べない（直列にすると行が消える。上の注意）
          s.text = ""
          s.userText = ""
          s.failed = null
          s.aborted = false
          s.dirty = false
          await send(row)
          return
        }

        if (type === "permission.asked" || type === "permission.replied") {
          if (!id) return
          const s = of(id)
          await send({
            type,
            session_id: id,
            pid: process.pid,
            cwd: s.cwd || directory || worktree || "",
            // 待ちの行は「何を待っているか」、答えた行は本文なし（再開の合図）
            text: type === "permission.asked" ? permissionText(props) : "",
            user_text: "",
            model: s.model,
          })
        }
      } catch {
        // 記録できないだけ。エージェントは止めない
      }
    },
  }
}
