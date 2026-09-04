// 返信（= セッションを再開して1ターン回す）ができるかの判定。
// サーバの POST 受付（server/app.ts）と画面の入力欄の出し分け（web/src/SessionView.tsx、web/src/FeedView.tsx）が
// 同じ関数を使い、ずれない。
import { entityId } from './entity.ts'
import type { FeedRow, SessionSummary } from './types.ts'

/** 返信できない理由。空文字なら返信できる */
export function replyBlockedReason(s: Pick<SessionSummary, 'id' | 'agent' | 'session_source'>): string {
  if (s.agent !== 'claude' && s.agent !== 'codex') return 'エージェントが不明なので再開できません'
  if (s.id.startsWith('unknown-')) return 'このセッションは再開できません（セッションIDが取れていない）'
  if (s.session_source === 'synth') return 'このセッションは再開できません（IDが合成）'
  if (s.session_source !== 'payload' && s.session_source !== 'rollout') return 'このセッションは再開できません（IDの出どころが不明）'
  return ''
}

// ---- フィードからの返信: @ メンションで返信先を選ぶ（web/src/ReplyBox.tsx / FeedView.tsx）

/** 返信先の候補。エンティティごとに1件 */
export interface ReplyTarget {
  id: string
  repo: string
  branch: string
  /** 表示名（付いていれば）、無ければ一番新しい入力の1行目。60文字 */
  title: string
  /** ブラウザから置いたアイコン画像の URL（SessionSummary.icon）。一覧から作った候補にだけ付く */
  icon?: string
  /** 返信できない理由。空なら選べる */
  blocked: string
}

const TARGET_TITLE_LEN = 60

function clipTitle(title: string): string {
  const t = (title.split('\n')[0] ?? '').trim()
  return t.length > TARGET_TITLE_LEN ? `${t.slice(0, TARGET_TITLE_LEN)}…` : t
}

/**
 * サイドバーの一覧（集計済みのセッション）から返信先の候補を作る。順番は一覧のまま（新しい順）。
 * ラベルは表示名（meta.name）があればそれ、無ければ一覧のタイトル。アイコンも載せる。
 * フィードの `@` はこれを主にし、一覧に無いものだけ feedReplyTargets で足す（mergeReplyTargets）
 */
export function sessionReplyTargets(sessions: SessionSummary[]): ReplyTarget[] {
  return sessions.map((s) => {
    const t: ReplyTarget = {
      id: s.id,
      repo: s.repo,
      branch: s.branch,
      title: clipTitle(s.meta?.name || s.title),
      blocked: replyBlockedReason(s),
    }
    if (s.icon) t.icon = s.icon
    return t
  })
}

/**
 * フィードの行から返信先の候補を作る。エンティティ（entityId）ごとに1件、新しい順（rows は古い順の前提）。
 * ラベルは一番新しい行の repo / branch / user_text（一覧のタイトルと同じく最後の入力に追従する）。
 * サイドバーとフィードで days や絞り込みが違い、一覧に無いセッションがフィードに出ることがあるので、
 * 一覧から作った候補（sessionReplyTargets）の後ろにこれを足す
 */
export function feedReplyTargets(rows: FeedRow[]): ReplyTarget[] {
  const seen = new Map<string, ReplyTarget>()
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    const id = entityId(r.session, r.repo, r.ts)
    if (seen.has(id)) continue
    seen.set(id, {
      id,
      repo: r.repo,
      branch: r.branch,
      title: clipTitle(r.user_text?.trim() || r.first_user_text?.trim() || r.text || ''),
      blocked: replyBlockedReason({ id, agent: r.agent, session_source: r.session_source }),
    })
  }
  return [...seen.values()]
}

/**
 * フィードの既定の返信先。「一番新しい行のセッションで、再開できて、処理中でないもの」。
 * A に返信すると数秒で A の入力の行が届いてフィードの先頭になるので、「一番新しい」だけだと既定が
 * 処理中の A 自身に固定され、B に返信するたび @ で選び直すことになる。処理中（busyIds）を飛ばして次を選ぶ。
 * 全部が処理中なら一番新しいもの（処理中）を返し、呼び出し側は送信だけ止める。
 * feed はフィードの行から作った候補（新しい順）、targets は一覧を先に並べた全候補（表示名・アイコン付き）。
 * 返すのは targets 側の同じ id（無ければ feed 側）。フィードに何も無ければ targets の先頭から同じ基準で選ぶ
 */
export function defaultReplyTarget(feed: ReplyTarget[], targets: ReplyTarget[], busyIds: ReadonlySet<string>): ReplyTarget | null {
  const first = (list: ReplyTarget[], skipBusy: boolean) => list.find((t) => !t.blocked && (!skipBusy || !busyIds.has(t.id)))
  const newest = first(feed, true) ?? first(feed, false)
  if (newest) return targets.find((t) => t.id === newest.id) ?? newest
  return first(targets, true) ?? first(targets, false) ?? null
}

/** 一覧の候補を先に、フィードにしか無いものを後ろに。同じ id は一覧側（表示名・アイコン付き）が勝つ */
export function mergeReplyTargets(list: ReplyTarget[], feed: ReplyTarget[]): ReplyTarget[] {
  const ids = new Set(list.map((t) => t.id))
  return [...list, ...feed.filter((t) => !ids.has(t.id))]
}

/** 検索語でリポジトリ / ブランチ / タイトルを部分一致（大文字小文字は無視）。空なら全部 */
export function filterReplyTargets(targets: ReplyTarget[], query: string): ReplyTarget[] {
  const q = query.toLowerCase()
  if (!q) return targets
  return targets.filter((t) => `${t.repo}\n${t.branch}\n${t.title}`.toLowerCase().includes(q))
}

/**
 * 入力欄の caret 位置から見て、いま打ちかけの @ メンション。
 * caret より前の最後の `@` が行頭か空白の直後にあり、そこから caret までに空白が無ければ
 * `{ start: その @ の位置, query: @ の後ろの文字 }`。無ければ null。
 * 半角の `@` だけ見る（全角の ＠ は普通の文字）。メールアドレスの途中では開かない
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const head = text.slice(0, caret)
  const start = head.lastIndexOf('@')
  if (start < 0) return null
  if (start > 0 && !/\s/.test(head.charAt(start - 1))) return null
  const query = head.slice(start + 1)
  if (/\s/.test(query)) return null
  return { start, query }
}

/**
 * 候補ごとの、入力欄に差し込む表記。`@repo`。同じリポジトリが複数あれば `@repo/branch`、
 * それでも被れば `~2` `~3` を足す（targets の順に若い番号。新しい順なので新しい方が無印）。
 * 空白を含まないので、後ろに空白を付けて差し込めば mentionQuery は「打ちかけ」と見なさない。
 * 表記は選んだ時点のものを FeedView が覚えるので、後で候補が増えて表記が変わっても本文の中は動かない
 */
export function mentionLabels(targets: ReplyTarget[]): Map<string, string> {
  const perRepo = new Map<string, number>()
  for (const t of targets) perRepo.set(t.repo, (perRepo.get(t.repo) ?? 0) + 1)
  const used = new Map<string, number>()
  const out = new Map<string, string>()
  for (const t of targets) {
    const base = (perRepo.get(t.repo) ?? 0) > 1 && t.branch ? `@${t.repo}/${t.branch}` : `@${t.repo}`
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    out.set(t.id, n > 1 ? `${base}~${n}` : base)
  }
  return out
}

/** 本文から表記を外す（送信するときと、✕ で返信先を戻すとき）。残った空白は1つにまとめる */
export function stripMention(text: string, label: string): string {
  return text.split(label).join('').replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/gm, '').trim()
}
