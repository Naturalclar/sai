import { QuoteButton } from './QuoteButton'
import { useQuoteSelection } from './useQuoteSelection'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { entityId } from '../../shared/entity.ts'
import { isRemoteHost } from '../../shared/host.ts'
import { sessionImageUrl } from '../../shared/images.ts'
import { digestKey } from '../../shared/digestFeedback.ts'
import { eventKind } from '../../shared/events.ts'
import { ImageSourceContext } from './imageContext'
import { LightboxProvider } from './LightboxProvider'
import { bubbleKey } from '../../shared/gallery.ts'
import type { GalleryItem } from './api'
import type { FeedRow, Profile, SessionSummary } from './api'
import { hm } from './format'
import { groupRows, speakerLabel } from './chatGroups.ts'
import { Message } from './Message'
import { SessionEndLine } from './SessionEndLine'
import { UnreadLine } from './UnreadLine'
import { SessionPrLink } from './SessionPrLink'
import { prForSession } from '../../shared/prs.ts'
import type { PrRepo } from '../../shared/types.ts'
import { firstUnreadKey } from './unreadMarks.ts'
import { JumpToBottom } from './JumpToBottom'
import { HostTag } from './HostTag'
import { opensDiff, type ChatDiffs } from './feedDiff.ts'
import { JUMP_FLASH_MS, type FeedJump } from './feedJump.ts'
import { followsBottom, followsResize, nearBottom, prepended } from './chatScroll.ts'
import { questionsFor, rowQuestions } from './terminalQuestion.ts'
import { wasClipped } from '../../shared/clipped.ts'
import type { PendingQuestion } from '../../shared/types.ts'
import type { MessageSide } from './hooks.ts'
import { drawnKey, focusSideIn, isFocused, messageCopyText, messageUrl } from './messageLink.ts'

const NO_SESSIONS: never[] = []
const NO_IDS: ReadonlySet<string> = new Set()

interface Props {
  /**
   * 返答の一部を選んで引用として返信欄に入れる（#604）。渡したとき（セッション画面で返信できるとき）だけ、選択の下に
   * 「引用して返信」を出す。渡すのは選んだ文字そのもの（引用の形にするのは呼ぶ側）
   */
  onQuote?: (selected: string) => void
  rows: FeedRow[]
  showChannel: boolean
  /**
   * このサーバのマシン名（#114）。`showChannel` のときだけ使い、別のマシンの行なら `#repo` の隣に `@host` を出す。
   * セッション画面は見出しに 1 つ出ているので、バブルごとには出さない
   */
  selfHost?: string
  /** 発言者の表示名・アイコンを引く元（SessionSummary.meta）。セッション画面はその1件、フィードはサイドバーの一覧 */
  sessions?: SessionSummary[]
  /**
   * 先頭に置く要素（#477。セッション画面の「前の 7 日を表示」）。前の行が足されたら、読んでいた場所がずれないよう
   * 足された高さぶん送り直す
   */
  leader?: ReactNode
  /** 末尾に足す仮の要素（送信中の返信など）。行と同じく最下部追従の対象 */
  trailer?: ReactNode
  /** エージェントのバブルに思考の折りたたみを出す（セッション画面だけ。フィードは出さない） */
  showThinking?: boolean
  /** 思考を最初から開いておく（ヘッダの「思考を全部開く」） */
  thinkingOpen?: boolean
  /**
   * 長い本文（`isLong`）を最初から開いた状態で出す（#365）。フィードだけが渡す。
   * 流し読みのたびに「もっと見る」を押さずに済む。畳みたいものは今までどおりボタンで畳める
   */
  longOpen?: boolean
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
   * 飛び先がどちら側か（#503。発言へのリンクと検索の当たり）。同じ `ts` の自分の入力と返答のうち、名指しした方にだけ着く。
   * 無ければ（side の無い前の形のリンク）今までどおりその `ts` の先に見つかった方
   */
  focusSide?: MessageSide
  /**
   * バブルから差分を開く（#280）。そのセッションのいまのブランチの PR に触れているエージェントのバブルにだけ
   * ボタンを出す（`feedDiff.ts` の `opensDiff()`）。フィードだけが渡す（セッション画面は入力欄にある）
   */
  diffs?: ChatDiffs
  /**
   * フィードの返信先から、そのセッションの最後の発言へ飛ぶ（#297）。`seq` が変わったときだけ送って光らせる
   * （同じバブルにもう一度飛べるように。`focusTs` は一度着地した ts には二度と送らない）。フィードだけが渡す
   */
  jumpTo?: FeedJump | null
  /**
   * 端末で開いた Claude が答えを待っている質問（#333。詳細の応答の `question`）。同じ文の、まだ解消していない待ちのバブルに
   * 選択肢を読むだけで出す（`terminalQuestion.ts` の `questionsFor()`）。セッション画面だけが渡す
   */
  question?: PendingQuestion
  /**
   * SAI の画面で質問に答えられるセッションの id（`terminalQuestion.ts` の `answerableIds()`）。行に載った選択肢（#334）を
   * 読むだけで出すのは、ここに無いセッションだけ（答えられるバブルと同じ質問を 2 つ並べない）
   */
  answerable?: ReadonlySet<string>
  /**
   * バブルの下に足す画像（#507。`shared/gallery.ts` の `imagesByBubble()`。鍵は `bubbleKey(ts, 自分 = user / 返答 = agent)`）。
   * セッション画面が渡す（1 つのセッションの分）
   */
  images?: ReadonlyMap<string, GalleryItem[]>
  /**
   * 同じものをセッションごとに分けたもの（#657。エンティティ ID → `bubbleKey` → 画像）。フィードが渡す。
   * `bubbleKey` はセッションの中でだけ一意なので、複数のセッションが混ざるフィードではセッションで引いてから鍵で引く
   */
  imagesBySession?: ReadonlyMap<string, ReadonlyMap<string, GalleryItem[]>>
  /**
   * 未読の線（#502）。このミリ秒より新しい最初の返答の前に「ここから未読」を引く。セッション画面だけが渡す
   * （開いたときの印を覚えて渡すので、読んだそばから線が消えることはない）
   */
  unreadAfter?: number
  /** 最下部が見えているあいだ、描き直すたびに呼ぶ（#502。既読の印を進める）。検索の飛び先へ送っている間は呼ばない */
  onSeenBottom?: () => void
  /** 返答のバブルの「⋯」に「ここから未読にする」を出す（#502）。押されたらその発言の ts を渡す */
  onMarkUnread?: (ts: string) => void
  /**
   * GitHub の open な PR（#554）。`showChannel`（フィード）のときだけ、見出しのセッションに紐づく PR へのリンクを
   * ブランチの横に出す（セッション画面は見出しと差分ボタンの横にある）
   */
  prs?: readonly PrRepo[]
}

/**
 * 見出しの PR へのリンク（#554）。**見出しに出ているブランチ（その発言を書いたときのもの）で引く**。セッションのいまのブランチで
 * 引くと、ブランチを移ったセッションの前の発言に別の PR が付く（#555 のレビュー。差分ボタンの #280 と同じ食い違い）。
 * 一覧に居ない・PR が無ければ何も出さない
 */
function prLinkOf(session: SessionSummary | undefined, branch: string, prs: readonly PrRepo[]) {
  const hit = session ? prForSession({ remote: session.remote, branch }, prs) : null
  return hit ? <SessionPrLink repo={hit.repo} pr={hit.pr} /> : null
}

/**
 * 飛んだバブルを光らせ直す。`.msg.found` はアニメーションで消えるので、class を付け直さないと 2 回目は光らない。
 * React の className は触らない（`found` は検索の `focusTs` のためのもので、こちらは要素に直接付けて時間で外す）
 */
function flash(el: HTMLElement) {
  el.classList.remove('found')
  void el.offsetWidth // 付け直したことをブラウザに認識させ、アニメーションを最初から再生させる
  el.classList.add('found')
  window.setTimeout(() => el.classList.remove('found'), JUMP_FLASH_MS)
}

export function Chat({ rows, leader, showChannel, selfHost = '', sessions = NO_SESSIONS, trailer, showThinking = false, thinkingOpen = false, longOpen = false, profile, linear = '', focusTs = '', focusSide: askedSide, diffs, jumpTo = null, question, answerable = NO_IDS, images, imagesBySession, unreadAfter, onSeenBottom, onMarkUnread, prs, onQuote }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // 返答の一部を選んだら「引用して返信」を出す（#604）。出すかの判定は quoteReply.ts の quotable()
  const quote = useQuoteSelection(ref, Boolean(onQuote))
  const stickToBottom = useRef(true)
  // 最後に最下部へ送ったときの scrollHeight。中身の高さが変わったときだけ送るため（#344）
  const appliedHeight = useRef(0)
  // 最下部が見えているか（描画にも使うので state）。見えていないときは「一番下へ」を出す
  const [atBottom, setAtBottom] = useState(true)
  // 最下部から離れた時点の行数。離れている間に増えた行の数をボタンに添える。最下部なら null
  const [awayAt, setAwayAt] = useState<number | null>(null)
  // エンティティID → セッション（表示名・アイコン画像）。バブルの見出しは行しか持っていないので、entityId で引く
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s] as const)), [sessions])

  // 検索から飛んできたら、その発言まで送る（#230）。当てるまでは最下部に追従しない
  // （追従すると、行が届くたびに下へ持っていかれて読めない）
  const days = groupRows(rows)
  // 名指しした側のバブルが描かれていなければ、側を問わずその ts に着く（`focusSideIn()` の説明）
  const drawn = new Set(days.flatMap((d) => d.groups.flatMap((g) => g.items.map((u) => drawnKey(u.row.ts, u.speaker === 'me' ? 'me' : 'agent')))))
  const focusSide = focusSideIn(drawn, focusTs, askedSide)
  // 「ここから未読」の線を引く発言（#502）
  const unreadKey = firstUnreadKey(days.flatMap((d) => d.groups.flatMap((g) => g.items)), unreadAfter)
  const landed = useRef('')
  // 着地したかは ts と側の組で覚える（同じ行の入力と返答へのリンクを続けて開いても、2 つ目にも送る）
  const focusKey = focusTs ? `${focusTs}|${focusSide ?? ''}` : ''
  useEffect(() => {
    if (!focusKey) {
      landed.current = ''
      return
    }
    if (landed.current === focusKey) return
    const side = focusSide ? `[data-side="${focusSide}"]` : ''
    const el = ref.current?.querySelector<HTMLElement>(`.msg[data-ts="${CSS.escape(focusTs)}"]${side}`)
    if (!el) return // まだ描画されていない（取得待ち）。次の描画で探し直す
    landed.current = focusKey
    stickToBottom.current = false
    el.scrollIntoView({ block: 'center' })
  })

  // フィードの返信先から飛ぶ（#297）。押すたびに seq が変わるので、同じバブルでもまた送る。
  // 着地したら最下部への追従を止める（検索と同じ。新しい行が届いても読んでいる場所から持っていかない）
  const jumped = useRef(0)
  useEffect(() => {
    if (!jumpTo || jumped.current === jumpTo.seq) return
    const el = ref.current?.querySelector<HTMLElement>(`.msg[data-key="${CSS.escape(jumpTo.key)}"]`)
    if (!el) return // まだ描画されていない。次の描画で探し直す
    jumped.current = jumpTo.seq
    stickToBottom.current = false
    el.scrollIntoView({ block: 'center' })
    flash(el)
  })

  // 最下部を見ていたときだけ、更新後も最下部に追従する。当たりへ送る間は割り込まない。
  // `trailer` は毎描画で新しい要素なので、この effect は 3 秒ごとの描き直しでも走る。中身の高さが
  // 変わったときだけ送らないと、最下部の近くにいる間ずっと引き戻される（#344）
  useEffect(() => {
    if (focusKey && landed.current !== focusKey) return
    const el = ref.current
    if (!el || (rows.length === 0 && !trailer)) return
    if (!followsBottom(stickToBottom.current, appliedHeight.current, el.scrollHeight)) return
    appliedHeight.current = el.scrollHeight
    el.scrollTop = el.scrollHeight
    // バブルの下の画像は行より後から届く（#657）。届いて高さが増えたときも、最下部を見ていれば送り直す
  }, [rows, trailer, focusKey, images, imagesBySession])

  // 箱の見えている高さが変わったとき（差分ボタンが出て入力欄の上に余白を取った・入力欄が伸びた・キーボードが出た）も、
  // 追従中なら最下部へ送り直す（#544）。上の effect は中身の高さしか見ないので、箱だけが縮むと最後の発言の下が隠れたまま止まる。
  // 飛び先へまだ着いていない間は割り込まない（上と同じ）。箱が無い（空の表示）間は見張らない
  const shown = rows.length > 0 || !!trailer
  const pendingFocus = useRef(false)
  useEffect(() => {
    pendingFocus.current = !!focusKey && landed.current !== focusKey
  })
  useEffect(() => {
    const el = ref.current
    if (!shown || !el || typeof ResizeObserver === 'undefined') return
    let prev = el.clientHeight
    const observer = new ResizeObserver(() => {
      const height = el.clientHeight
      if (followsResize(stickToBottom.current, prev, height) && !pendingFocus.current) {
        appliedHeight.current = el.scrollHeight
        el.scrollTop = el.scrollHeight
      }
      prev = height
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [shown])

  // 先頭に前の行が足されたら、足された高さぶん送り直して読んでいた場所に留まる（#477）。
  // ブラウザのスクロールアンカーは Safari に無く、先頭（scrollTop 0）で押したときは Chrome でも効かないので自分で合わせる
  const topTs = useRef('')
  const lastHeight = useRef(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const first = rows[0]?.ts ?? ''
    if (prepended(topTs.current, first) && !stickToBottom.current) el.scrollTop += el.scrollHeight - lastHeight.current
    topTs.current = first
    lastHeight.current = el.scrollHeight
  })

  // 最下部まで見えていれば既読にする（#502）。飛び先へまだ着いていない間と、タブが隠れている間は数えない
  // （着いたあとは数える。URL の ts は残るので、focusKey があるだけで止めるとリンクから開いたセッションが既読にならない）。
  // 新しい行が届いたときも呼び直すのは、呼び出し側の onSeenBottom が行を依存に持って作り直されるから
  useEffect(() => {
    if (!onSeenBottom || !atBottom || (focusKey && landed.current !== focusKey) || document.visibilityState !== 'visible') return
    onSeenBottom()
  }, [atBottom, focusKey, onSeenBottom])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const near = nearBottom(el.scrollHeight, el.scrollTop, el.clientHeight)
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
    // 押した時点の高さを覚えておく（動き終わったあと、中身が変わっていないのにもう一度送らない）
    appliedHeight.current = el.scrollHeight
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
  }

  if (rows.length === 0 && !trailer) return <div className="empty">まだ何もありません</div>

  // 離れている間に増えた行。フィルタが変わって行が減ることもあるので 0 で止める。trailer（仮バブル）は数えない
  const arrived = atBottom || awayAt === null ? 0 : Math.max(0, rows.length - awayAt)

  // 画像はページの中のライトボックスで開く（#507）。バブルの中の画像・添付・バブルの下の画像のどれも
  return (
    <LightboxProvider>
    <div className="chat-wrap">
      {quote.pick && onQuote && (
        <QuoteButton
          left={quote.pick.left}
          top={quote.pick.top}
          onQuote={() => {
            onQuote(quote.pick!.text)
            quote.clear()
          }}
        />
      )}
      <div className="chat" ref={ref} onScroll={onScroll}>
        {leader}
        {days.map((day) => (
          <div key={day.day}>
            <div className="day"><span>{day.label}</span></div>
            {day.groups.map((g) => {
              const id = entityId(g.session, g.repo, g.firstTs)
              // セッションが終わった区切り（#385）。発言ではないので、アバターも名前も出さない
              if (g.divider) {
                const end = g.items[0]!
                return <SessionEndLine key={`end:${end.key}`} text={end.text} ts={end.row.ts} />
              }
              const who = speakerLabel(g.speaker, byId.get(id), profile)
              // 送ったメッセージへの返答（#588）。名前は相手の呼び名にし、相手のセッションへのリンクを添える
              const reply = g.items[0]?.reply
              return (
                <div className={`group${reply ? ' agent-reply' : ''}`} key={`${g.speaker}:${g.session}:${g.firstTs}`}>
                  <div className={`avatar ${g.speaker}`}>{who.icon ? <img src={who.icon} alt="" /> : who.mark}</div>
                  <div>
                    <div className="gh">
                      <span className="name">{reply ? reply.to_name : who.name}</span>
                      {reply && (
                        <a className="reply-of" href={`#/s/${encodeURIComponent(id)}`} title={`送ったメッセージ（id: ${reply.message_id}）への返答。押すと相手のセッションを開く`}>
                          送ったメッセージへの返答
                        </a>
                      )}
                      {/* 送り元のエージェントがこの返答を知っているか（#594）。渡すのは次に SAI から回すターンの頭か、sai_wait */}
                      {reply && (
                        <span
                          className={`handed${reply.handed_at ? ' done' : ''}`}
                          title={reply.handed_at ? `${hm(reply.handed_at)} にこのセッションの会話に渡した` : 'このセッションのエージェントはまだ読んでいません。次に SAI から送るターンの頭に添えます'}
                        >
                          {reply.handed_at ? '会話に渡した' : '次のターンで渡す'}
                        </span>
                      )}
                      {showChannel && (
                        <a className="ch" href={`#/s/${encodeURIComponent(id)}`} title={g.session}>#{g.repo}</a>
                      )}
                      {showChannel && isRemoteHost(g.host, selfHost) && <HostTag host={g.host} />}
                      {g.branch && <code className="branch" title={g.branch}>{g.branch}</code>}
                      {showChannel && prs && prLinkOf(byId.get(id), g.branch, prs)}
                      <span className="time">{hm(g.firstTs)}</span>
                    </div>
                    {g.items.map((u) => {
                      // 差分のボタンは、いまのブランチの PR に触れているエージェントのバブルだけ（#280）
                      const summary = diffs && u.speaker !== 'me' && !u.waiting ? diffs.summaries.get(id) : undefined
                      const diff = diffs && summary && opensDiff(u.text, u.row.remote, summary)
                        ? { summary, open: diffs.open === id, onToggle: () => diffs.onToggle(id) }
                        : null
                      // 本文の画像はサーバが配る（#321）。別のマシンのセッションのファイルはこちらに無いので、印と名前だけ
                      const imageUrl = u.speaker !== 'me' && !isRemoteHost(g.host, selfHost) ? (src: string) => sessionImageUrl(id, src) : null
                      const side: MessageSide = u.speaker === 'me' ? 'me' : 'agent'
                      // バブルの中に出ていない、この発言の画像（#507）。待ちのバブルには付けない
                      const imageKey = bubbleKey(u.row.ts, side === 'me' ? 'user' : 'agent')
                      const extra = u.waiting ? undefined : (images?.get(imageKey) ?? imagesBySession?.get(id)?.get(imageKey))
                      // 発言ごとの「⋯」（#503）。待ちのバブルは発言ではないので出さない。リンクはフィードからでもセッション画面へ向ける
                      const menu = u.waiting
                        ? undefined
                        : {
                            link: messageUrl(location, id, u.row.ts, side),
                            text: messageCopyText(u.text, side),
                            clipped: u.clipped,
                            // 未読に戻せるのは返答だけ（#502。未読に数えるのは返答なので）
                            // 返答（#588）は相手のセッションの行なので、このセッションの未読には戻せない
                            ...(onMarkUnread && side === 'agent' && !u.reply ? { onMarkUnread: () => onMarkUnread(u.row.ts) } : {}),
                          }
                      // 自分の入力は Markdown にしない（打ったままを出す）。エージェントの返答は Markdown。
                      // 一言があるバブルには「変？」を出す（#346）。鍵はサーバ（作る側）と同じ関数で作る
                      return (
                      <ImageSourceContext key={u.key} value={imageUrl}>
                      {u.key === unreadKey && <UnreadLine />}
                      {u.handedReplies ? (
                        <div className="handed-note" title="SAI がこの指示の頭に、別のセッションからの返答を足してエージェントに渡した（記録にはそのまま残る）">
                          返答 {u.handedReplies} 件を添えました
                        </div>
                      ) : null}
                      {u.loop ? (
                        <div className="handed-note" title="SAI がループの周として送った入力（目的・終わりの条件・前の周の申し送りを渡している。全文は記録に残る）">
                          ループが送りました
                        </div>
                      ) : null}
                      <Message
                        {...(diff ? { diff } : {})}
                        ts={u.row.ts}
                        text={u.text}
                        markdown={u.speaker !== 'me'}
                        waiting={u.waiting}
                        questions={rowQuestions(u, byId.get(id), answerable.has(id)) ?? questionsFor(u, question)}
                        resolved={u.resolved}
                        thinking={showThinking ? u.thinking : undefined}
                        thinkingOpen={thinkingOpen}
                        summary={u.summary}
                        digestKey={u.summary ? digestKey(u.row) : undefined}
                        model={u.model}
                        usage={u.speaker !== 'me' && !u.waiting ? u.row.usage : undefined}
                        recovered={u.speaker !== 'me' && !u.waiting && Boolean(u.row.recovered)}
                        // このターンで実行したコマンド・ツール（#605）。ターン完了の返答にだけ、Claude と Codex だけ。別のセッションの返答（#588）には付けない
                        {...(u.speaker !== 'me' && !u.waiting && !u.reply && (u.row.agent === 'claude' || u.row.agent === 'codex') && eventKind(u.row.event, u.row.text) === 'turn' ? { steps: { id, ts: u.row.ts } } : {})}
                        remote={u.row.remote}
                        sourceAsk={u.row.user_text}
                        linear={linear}
                        found={isFocused(u.row.ts, side, focusTs, focusSide)}
                        utteranceKey={u.key}
                        side={side}
                        {...(menu ? { menu } : {})}
                        {...(extra ? { images: extra } : {})}
                        clipped={u.clipped}
                        thinkingClipped={showThinking && wasClipped(u.row, 'thinking')}
                        defaultOpen={longOpen}
                      />
                      </ImageSourceContext>
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
    </LightboxProvider>
  )
}
