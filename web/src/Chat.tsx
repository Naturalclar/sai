import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { entityId } from '../../shared/entity.ts'
import { isRemoteHost } from '../../shared/host.ts'
import type { FeedRow, Profile, SessionSummary } from './api'
import { hm } from './format'
import { groupRows, speakerLabel } from './chatGroups.ts'
import { Message } from './Message'
import { JumpToBottom } from './JumpToBottom'
import { HostTag } from './HostTag'
import { opensDiff, type ChatDiffs } from './feedDiff.ts'

const NO_SESSIONS: never[] = []

interface Props {
  rows: FeedRow[]
  showChannel: boolean
  /**
   * このサーバのマシン名（#114）。`showChannel` のときだけ使い、別のマシンの行なら `#repo` の隣に `@host` を出す。
   * セッション画面は見出しに 1 つ出ているので、バブルごとには出さない
   */
  selfHost?: string
  /** 発言者の表示名・アイコンを引く元（SessionSummary.meta）。セッション画面はその1件、フィードはサイドバーの一覧 */
  sessions?: SessionSummary[]
  /** 末尾に足す仮の要素（送信中の返信など）。行と同じく最下部追従の対象 */
  trailer?: ReactNode
  /** エージェントのバブルに思考の折りたたみを出す（セッション画面だけ。フィードは出さない） */
  showThinking?: boolean
  /** 思考を最初から開いておく（ヘッダの「思考を全部開く」） */
  thinkingOpen?: boolean
  /** 自分の表示名とアイコン（自分側のバブル） */
  profile?: Profile
  /** Linear の workspace（設定）。一言の中の PGR-123 のリンク先。空ならリンクにしない */
  linear?: string
  /**
   * 検索から飛んできた当たりの `ts`（#230）。その発言まで送って光らせ、**最下部には送らない**。
   * その ts の行がまだ無ければ（窓の外、取得待ち）何もしない
   */
  focusTs?: string
  /**
   * バブルから差分を開く（#280）。そのセッションのいまのブランチの PR に触れているエージェントのバブルにだけ
   * ボタンを出す（`feedDiff.ts` の `opensDiff()`）。フィードだけが渡す（セッション画面は入力欄にある）
   */
  diffs?: ChatDiffs
}

export function Chat({ rows, showChannel, selfHost = '', sessions = NO_SESSIONS, trailer, showThinking = false, thinkingOpen = false, profile, linear = '', focusTs = '', diffs }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  // 最下部が見えているか（描画にも使うので state）。見えていないときは「一番下へ」を出す
  const [atBottom, setAtBottom] = useState(true)
  // 最下部から離れた時点の行数。離れている間に増えた行の数をボタンに添える。最下部なら null
  const [awayAt, setAwayAt] = useState<number | null>(null)
  // エンティティID → セッション（表示名・アイコン画像）。バブルの見出しは行しか持っていないので、entityId で引く
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s] as const)), [sessions])

  // 検索から飛んできたら、その発言まで送る（#230）。当てるまでは最下部に追従しない
  // （追従すると、行が届くたびに下へ持っていかれて読めない）
  const landed = useRef('')
  useEffect(() => {
    if (!focusTs) {
      landed.current = ''
      return
    }
    if (landed.current === focusTs) return
    const el = ref.current?.querySelector<HTMLElement>(`.msg[data-ts="${CSS.escape(focusTs)}"]`)
    if (!el) return // まだ描画されていない（取得待ち）。次の描画で探し直す
    landed.current = focusTs
    stickToBottom.current = false
    el.scrollIntoView({ block: 'center' })
  })

  // 最下部を見ていたときだけ、更新後も最下部に追従する。当たりへ送る間は割り込まない
  useEffect(() => {
    if (focusTs && landed.current !== focusTs) return
    const el = ref.current
    if (el && stickToBottom.current && (rows.length > 0 || trailer)) el.scrollTop = el.scrollHeight
  }, [rows, trailer, focusTs])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    stickToBottom.current = near
    // onScroll は連続して鳴るので、値が変わったときだけ state を触る
    if (near !== atBottom) {
      setAtBottom(near)
      setAwayAt(near ? null : rows.length)
    }
  }

  /** 「一番下へ」。動き終われば onScroll が最下部と判定して、以後の新しい行に追従する */
  const jump = () => {
    const el = ref.current
    if (!el) return
    stickToBottom.current = true
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
  }

  if (rows.length === 0 && !trailer) return <div className="empty">まだ何もありません</div>

  // 離れている間に増えた行。フィルタが変わって行が減ることもあるので 0 で止める。trailer（仮バブル）は数えない
  const arrived = atBottom || awayAt === null ? 0 : Math.max(0, rows.length - awayAt)

  return (
    <div className="chat-wrap">
      <div className="chat" ref={ref} onScroll={onScroll}>
        {groupRows(rows).map((day) => (
          <div key={day.day}>
            <div className="day"><span>{day.label}</span></div>
            {day.groups.map((g) => {
              const id = entityId(g.session, g.repo, g.firstTs)
              const who = speakerLabel(g.speaker, byId.get(id), profile)
              return (
                <div className="group" key={`${g.speaker}:${g.session}:${g.firstTs}`}>
                  <div className={`avatar ${g.speaker}`}>{who.icon ? <img src={who.icon} alt="" /> : who.mark}</div>
                  <div>
                    <div className="gh">
                      <span className="name">{who.name}</span>
                      {showChannel && (
                        <a className="ch" href={`#/s/${encodeURIComponent(id)}`} title={g.session}>#{g.repo}</a>
                      )}
                      {showChannel && isRemoteHost(g.host, selfHost) && <HostTag host={g.host} />}
                      {g.branch && <span className="branch">{g.branch}</span>}
                      <span className="time">{hm(g.firstTs)}</span>
                    </div>
                    {g.items.map((u) => {
                      // 差分のボタンは、いまのブランチの PR に触れているエージェントのバブルだけ（#280）
                      const summary = diffs && u.speaker !== 'me' && !u.waiting ? diffs.summaries.get(id) : undefined
                      const diff = diffs && summary && opensDiff(u.text, u.row.remote, summary)
                        ? { summary, open: diffs.open === id, onToggle: () => diffs.onToggle(id) }
                        : null
                      // 自分の入力は Markdown にしない（打ったままを出す）。エージェントの返答は Markdown
                      return (
                      <Message
                        key={u.key}
                        {...(diff ? { diff } : {})}
                        ts={u.row.ts}
                        text={u.text}
                        markdown={u.speaker !== 'me'}
                        waiting={u.waiting}
                        resolved={u.resolved}
                        thinking={showThinking ? u.thinking : undefined}
                        thinkingOpen={thinkingOpen}
                        summary={u.summary}
                        model={u.model}
                        remote={u.row.remote}
                        linear={linear}
                        found={focusTs !== '' && u.row.ts === focusTs}
                      />
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
        {trailer}
      </div>
      {!atBottom && <JumpToBottom count={arrived} onClick={jump} />}
    </div>
  )
}
