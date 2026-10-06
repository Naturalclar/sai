// 「要対応」（#224）に並べるものを組み立てる。DOM に依存しないので todoItems.test.ts を node:test で回す。
import { stripMarkdown } from './markdown.ts'
import { replyBlockedReason } from './reply.ts'
import type { Approval, ApprovalMap, LoopMap, ReplyingMap, SessionSummary } from './types.ts'

/**
 * - `answer`: エージェントが答えを待っていて、SAI がその口を持っている。**この画面から答えられる**
 * - `watch`: 記録の行から見た待ち（`SessionSummary.waiting`）。SAI に選択肢が届いていないので
 *   ボタンは出せないが、**返信欄からは打てることが多い**（`replyable`）
 * - `done`: **詰まってはいない。ターンが終わって次の指示を待っているだけ**（#438 / #513。判定は `awaitsNext()`）。
 *   `answer` / `watch` と同じ重さで出すと、本当に答えを待っているものが埋もれるので、
 *   画面では下段に置き、**バッジ・タブの題名・通知には数えない**（`pendingItems()`）
 */
export type TodoKind = 'answer' | 'watch' | 'done'

export interface TodoItem {
  /** エンティティID */
  id: string
  kind: TodoKind
  /** 何を待っているか（1行） */
  text: string
  /** いつから待っているか。並べ替えの基準 */
  since: string
  /** 一覧に居れば。**絞り込みで隠れている `answer` では null になる**（後述） */
  session: SessionSummary | null
  /** kind === 'answer' のときだけ。そのまま ApprovalBubble に渡す */
  approval: Approval | null
  /**
   * `watch` / `done` のとき、SAI の返信欄からその会話に打ち込めるか（#232）。
   * 打てるなら「開いて返信欄から答えられます」、打てないなら「端末で答えてください」を出す。
   * **「SAI からは答えられない」と決めつけない**（端末で開いていれば打ち込めるし、再開もできる）
   */
  replyable: boolean
  /**
   * `text` の後ろに小さく添える文（#713）。`done` で、最後のターンの一言が 2 つで組まれているときだけ:
   * `text` が「人が次にすること」、こちらが「何が起きたか」。無ければ今までどおり `text` だけ
   */
  sub?: string
}

/**
 * 待たせている順（古い順）。同時刻は ID で決めて、ポーリングのたびに並びが揺れないようにする。
 *
 * **`answer` は絞り込みに関わらず全部出す。** `/api/sessions` の `approvals` は
 * `Approvals.snapshot()` そのもので、リポジトリや日数の絞り込みを通っていない（サーバ側で確認）。
 * ここはエージェントを止めている＝取りこぼすと困るものなので、一覧から消えていても出す
 * （その場合 `session` が null になり、画面は ID を出すだけになる）。
 * 逆に `watch` / `done` は `SessionSummary` からしか作れないので、**絞り込みには従う**。
 *
 * **別プロセスの返信を処理中のセッションは `watch` を出さない**（#232）。`claude -p` の許可・質問は
 * 必ず `--permission-prompt-tool` を通るので、答え待ちがあれば上の `answer` に載っている。
 * 載っていなければ「答えを待っている」のではなく「動いている」。行の `waiting` は
 * **待ちの行より後にターン完了の行が届くまで消えない**ので、答えたあとも残ってしまう
 * （許可や質問への回答は `UserPromptSubmit` ではないため `record.py` は再開の行を書かない）。
 * 端末に打ち込んだ返信（`via: 'terminal'`）は SAI に口が無く、行の `waiting` だけが手がかりなので**残す**。
 *
 * **`done`（終わって次を待っているだけ）も同じ条件で落とす**（#438）: 答え待ちが出ていれば `answer` が勝ち、
 * アーカイブ済みは出さない。**返信が処理中なら経路を問わず落とす**（端末に打ち込んだ返信も、ターンが回っている）。
 *
 * `selfHost` はこのサーバのマシン名（応答の `host`。#114）。別のマシンのセッションは項目としては出すが
 * （待っていることに変わりはない）、ここからは答えられないので `replyable` は false になる。
 */
export function todoItems(sessions: readonly SessionSummary[], approvals: ApprovalMap, selfHost: string, replying: ReplyingMap = {}, loops: LoopMap = {}): TodoItem[] {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const out: TodoItem[] = []
  for (const [id, list] of Object.entries(approvals)) {
    const first = list?.[0]
    if (!first) continue
    out.push({ id, kind: 'answer', text: first.text, since: first.since, session: byId.get(id) ?? null, approval: first, replyable: false })
  }
  const answering = new Set(out.map((t) => t.id))
  for (const s of sessions) {
    // 答え待ちが出ているセッションは上で入れてある（そちらの方が新しくて具体的）
    if (answering.has(s.id) || s.archived) continue
    if (s.waiting) {
      if (processReplying(replying[s.id])) continue
      out.push({ id: s.id, kind: 'watch', text: s.waiting, since: s.end, session: s, approval: null, replyable: watchReplyable(s, selfHost) })
      continue
    }
    if (!awaitsNext(s)) continue
    const r = replying[s.id]
    if (r && !r.failed) continue
    // ループ（#634）が次の周を待っている間は「終わって次を待っている」に出さない（次は SAI が起こす）。
    // 終わった・諦めた・止まった・一時停止したループのセッションは出る（人が結果を見る）
    if (loops[s.id]?.status === 'running') continue
    // `入力待ち`（端末で放置）はその文言のまま、ターンが終わっただけのものは最後の発言（一言があればそれ）
    // 本文は Markdown のままなので、一覧の 2 行目と同じく記号を落とす（`[#374](https://…)` がそのまま出ていた）
    // 一言が 2 つで組まれていれば（#713）、「人が次にすること」を先に、「何が起きたか」を後ろに小さく
    const next = s.idle ? '' : stripMarkdown((s.last_summary && s.last_summary_next) || '')
    const what = stripMarkdown(s.last_summary || s.last_text || '')
    const text = s.idle || next || what || '（本文なし）'
    out.push({ id: s.id, kind: 'done', text, since: s.idle ? s.end : s.last_turn_ts || s.end, session: s, approval: null, replyable: watchReplyable(s, selfHost), ...(next && what ? { sub: what } : {}) })
  }
  return out.sort((a, b) => (a.since === b.since ? a.id.localeCompare(b.id) : a.since < b.since ? -1 : 1))
}

/**
 * **ターンが終わって、次の指示を待っているか**（#513）。
 *
 * 前は `SessionSummary.idle`（Claude の `idle_prompt`。`入力待ち`…）だけを見ていたが、これは**端末の TUI で開いた Claude が
 * 60 秒放置されたとき**にしか鳴らない（SAI から返信した `claude -p`・Codex・OpenCode は鳴らさない）。実測（直近 7 日）で
 * ターン完了の行 360 本に対して `入力待ち` は 17 本で、終わっているセッションのほとんどが下段に出ていなかった。
 *
 * そこで**最後の行がターン完了**（`last_kind === 'turn'`）も数える。後ろに何か来ていれば最後の行が変わるので自然に外れる:
 * 次の入力（`UserPromptSubmit`＝ターンが回っている）、`SessionEnd`（`/clear` で会話は別のセッションに移った）、
 * 待ちの行（`watch` の方）。**時刻（`end === last_turn_ts`）では比べない**——行の `ts` は秒までなので、
 * ターン完了と同じ秒に届いた次の入力や `/clear` を見分けられない（#517 のレビュー）
 */
export function awaitsNext(s: Pick<SessionSummary, 'idle' | 'last_kind'>): boolean {
  return Boolean(s.idle) || s.last_kind === 'turn'
}

/**
 * その待ちに、SAI の返信欄から**答えられる**か。
 *
 * **OpenCode の待ちは必ず許可待ち**（プラグインが書く待ちの行は `permission.asked` だけ）で、
 * **返信を送っても保留中の許可は解けない**（止まっているのは許可の待ちなので、次のターンの入力にしかならない）。
 * SAI が起こしたサーバが持っている分は `answer` として上に出ているので、ここに残っているのは
 * **端末の TUI か、人が立てた別のサーバの分＝ SAI からは触れないもの**（#421）。だから「端末で答えて」に倒す。
 * Claude / Codex は今までどおり、返信欄から打ち込めるかだけで決める（#232）
 */
function watchReplyable(s: SessionSummary, selfHost: string): boolean {
  if (s.agent === 'opencode') return false
  return replyBlockedReason(s, selfHost) === ''
}

/** 別プロセス（`-p` / `exec resume`）の返信が動いている。失敗して残っている分は「動いている」ではない */
function processReplying(r: ReplyingMap[string] | undefined): boolean {
  return Boolean(r) && r!.via !== 'terminal' && !r!.failed
}

/**
 * **数えるぶん**（バッジ・タブの題名・通知）。`done` は「終わって次を待っている」だけなので数えない（#438）。
 *
 * 数え方を呼び出し側ごとに書くと、サイドバーのバッジが 3 でタブの題名が 1 のような食い違いが出るので、
 * `todoItems()` と同じくここに 1 つだけ置く（#231 / #340 と同じ考え方）
 */
export function pendingItems(items: readonly TodoItem[]): TodoItem[] {
  return items.filter((t) => t.kind !== 'done')
}

/** 「終わって次を待っている」ぶん（要対応の下段）。`pendingItems()` の裏返し */
export function doneItems(items: readonly TodoItem[]): TodoItem[] {
  return items.filter((t) => t.kind === 'done')
}

/** 要対応の画面の段（#551）。上から `answer` → `unread` → `watch` → `done` の順に出す */
export interface TodoSections {
  /** 答え待ち。この画面から答えられるので、未読かどうかに関わらず一番上 */
  answer: TodoItem[]
  /** 未読の返答があるセッション（`watch` も `done` も）。読んでいない返答が下段の奥に埋もれないように上げる */
  unread: TodoItem[]
  /** 未読の無い待機中 */
  watch: TodoItem[]
  /** 未読の無い「終わって次を待っている」 */
  done: TodoItem[]
}

/**
 * 画面に出す順に段へ分ける（#551）。各段の中は `todoItems()` の並び（待たせている順）のまま。
 *
 * **並びを変えるだけで、数えるぶん（`pendingItems()`）は変えない。** 未読で上がった `done` をバッジや通知に数えると、
 * 返答を 1 回読まないだけで通知が鳴るようになる。行の `kind` も変えないので、返信欄を最初から開くのは
 * 今までどおり `done` の行だけ（#522）
 */
export function todoSections(items: readonly TodoItem[]): TodoSections {
  const out: TodoSections = { answer: [], unread: [], watch: [], done: [] }
  for (const t of items) {
    if (t.kind === 'answer') out.answer.push(t)
    else if ((t.session?.unread ?? 0) > 0) out.unread.push(t)
    else out[t.kind].push(t)
  }
  return out
}
