// 「着手して」は要約（/compact）してから始める（#579）。どの送り方を既定にするか・何を出すかの判定と、要約に添える指示。
// DOM にもプロセスにも触らない純粋関数なので、画面（ReplyBox）とサーバ（POST reply の compact）が同じものを見る。compact.test.ts で回す。
//
// 実データ（9/16〜9/30 の SAI が起こした Claude のターン）で、トークンの 97.3% が会話の読み直しだった。自動の要約は
// 文脈がほぼ満杯（約 97 万）になるまで走らず、要約すれば約 8 万に落ちる。新しい作業に取りかかる前に 1 回要約する

/** これより小さいセッションは要約しない（新しいセッションの最初は約 4.9 万・要約の直後は約 8.3 万で、得るものが無い） */
export const COMPACT_MIN_TOKENS = 150_000

/**
 * 前のターンが終わってからこれを過ぎたセッションは、**プロンプトキャッシュが切れている見込み**として扱う（#761）。
 * 切れるのは 60 分で（実測は docs/history/reply.md の #732 の節）、起動・要約にかかる分を引いて手前に置く。
 * 待ち（#732）の「自動では起こさない」線（`shared/waits.ts` の `WAIT_AUTO_WAKE_MS`）もこの値。**線を変えるならここ**
 */
export const CACHE_COLD_MS = 50 * 60_000

/**
 * キャッシュが切れている見込みで、文脈がこれ以上なら、本文が着手の形でなくても「要約してから送る」を既定にする（#761）。
 * **仮の値**（見出しの警告 `CONTEXT_WARN_TOKENS` と同じ区切り）。変えるならここ
 */
export const COLD_COMPACT_TOKENS = 400_000

/** 最後のターン完了（`SessionSummary.last_turn_ts`）からの時間。分からなければ undefined（先の時刻は 0） */
export function idleMsSince(lastTurnTs: string | undefined, now: number): number | undefined {
  const at = lastTurnTs ? Date.parse(lastTurnTs) : NaN
  return Number.isFinite(at) ? Math.max(0, now - at) : undefined
}

/**
 * 入力欄で使う間（#761）。**時計を渡されていない（`now` が 0）・処理中か預かりがある（`queueing`）ときは分からない扱い**
 * （いま回っているので、前のターンからの間に意味が無い）。入力欄の 1 行と、送り方の既定の両方がこれを見る
 */
export function replyIdleMs(input: { lastTurnAt: string | undefined; now: number; queueing: boolean }): number | undefined {
  return input.now > 0 && !input.queueing ? idleMsSince(input.lastTurnAt, input.now) : undefined
}

/** キャッシュが切れている見込みか。**間が分からなければ切れていない側**（分からないのに要約を挟まない） */
export function cacheCold(idleMs: number | undefined): boolean {
  return idleMs !== undefined && idleMs > CACHE_COLD_MS
}

/** `12 分` / `1 時間 20 分` / `3 日`。分からなければ空 */
export function idleLabel(idleMs: number | undefined): string {
  if (idleMs === undefined) return ''
  const min = Math.floor(idleMs / 60_000)
  if (min < 60) return `${min} 分`
  if (min < 24 * 60) return `${Math.floor(min / 60)} 時間${min % 60 ? ` ${min % 60} 分` : ''}`
  return `${Math.floor(min / (24 * 60))} 日`
}

/** 入力欄に出す、送る前の大きさと間（#761）。`cold` はキャッシュが切れている見込み */
export interface SendCost {
  /** `いま 810k ・ 最後のターンから 1 時間 12 分` */
  text: string
  cold: boolean
  title: string
}

/**
 * 入力欄に出す 1 行（#761）。読み直す量（分かれば）と最後のターンからの時間（分かれば）。どちらも分からなければ null。
 * **キャッシュの印は Claude だけ**（60 分で切れるのを確かめたのは Claude の記録。ほかは分からないので出さない）。
 * `context` は `contextLabel()` を通した文字（`810k`。分からなければ空）
 */
export function sendCost(input: { agent: string; context: string; idleMs: number | undefined }): SendCost | null {
  const idle = idleLabel(input.idleMs)
  if (!input.context && !idle) return null
  const cold = input.agent === 'claude' && cacheCold(input.idleMs)
  const parts = [...(input.context ? [`いま ${input.context}`] : []), ...(idle ? [`最後のターンから ${idle}`] : [])]
  const reads = input.context ? `送ると、この量（${input.context} トークン）を読み直します` : ''
  const why = cold
    ? `最後のターンから ${Math.round(CACHE_COLD_MS / 60_000)} 分を過ぎているので、キャッシュが切れている見込みです。短い返信でも文脈をほぼ全部書き直します`
    : ''
  return { text: parts.join(' ・ '), cold, title: [reads, why].filter(Boolean).join('\n') }
}

/**
 * 返信の送り方。`compact` = 要約してから送る、`plain` = そのまま、`new` = 新しいセッションで送る、
 * `fork` = 会話ごと分岐して、分岐先に送る（#405 の Codex、#398 の OpenCode）
 */
export type SendMode = 'compact' | 'plain' | 'new' | 'fork'

export const SEND_MODE_LABEL: Record<SendMode, string> = {
  compact: '要約してから送る',
  plain: 'そのまま送る',
  new: '新しいセッションで送る',
  fork: '分岐して送る',
}

/** 狭い画面・タッチ端末で、閉じているときに出す短い表記（#629）。開いたメニューは `SEND_MODE_LABEL` のまま */
export const SEND_MODE_SHORT: Record<SendMode, string> = {
  compact: '要約',
  plain: 'そのまま',
  new: '新規',
  fork: '分岐',
}

/**
 * 1 行目が「着手して」の形か。**狭い方に倒す**（着手でない文を要約してから送る方が害が大きい。取りこぼしたら人が選べばよい）。
 * 実データ（人の入力 1,800 回）で 1 行目が着手の形だったのは 215 回: `着手して` / `N着手して` / `Nに着手して` / `N対応して` / `Nを着手して`。
 * 番号の前の `#`、後ろの `ください`・句点・感嘆符は許す。`修正も着手して`・`セッション C のセッションでN着手` のような形は当てない（続きに送るだけ）
 */
export function startsNewWork(text: string): boolean {
  const first = (text.split('\n')[0] ?? '').trim()
  return /^(?:(?:#?\d+\s*(?:に|を)?\s*)?着手|#?\d+\s*(?:に|を)?\s*対応)(?:して|してください|します|お願いします)[。．.!！]?$/.test(first)
}

/** 送り方を選ぶ材料 */
export interface SendModeInput {
  text: string
  agent: string
  /** 返信先のいまのコンテキスト量（#441）。分からなければ 0 */
  contextTokens: number
  /** 端末（tmux）で開いている。**要約は別プロセスでしか回さない**（端末の TUI に打ち込むと、要約中の入力の扱いを確かめていない） */
  terminal: boolean
  /**
   * 会話ごと分岐できる（#405）。Codex の、返信できる（ID が rollout から引けている・このマシンの）セッション。
   * 端末で開いているものには出さない（サーバも `codexHeldElsewhere()` で断る）
   */
  forkable?: boolean
  /** 最後のターン完了からの時間（`idleMsSince()`。#761）。分からなければ省略 */
  idleMs?: number
}

/** 要約を選べるか。Claude で、端末で開いておらず、下限以上のとき（量が分からなければ出さない） */
export function canCompact(input: Pick<SendModeInput, 'agent' | 'contextTokens' | 'terminal'>): boolean {
  return input.agent === 'claude' && !input.terminal && input.contextTokens >= COMPACT_MIN_TOKENS
}

/**
 * 間があいて大きいか（#761）: キャッシュが切れている見込みで、文脈が `COLD_COMPACT_TOKENS` 以上。
 * 短い返信でも文脈をほぼ全部書き直すので、要約できる相手なら要約が既定になる
 */
export function coldAndLarge(input: Pick<SendModeInput, 'contextTokens' | 'idleMs'>): boolean {
  return cacheCold(input.idleMs) && input.contextTokens >= COLD_COMPACT_TOKENS
}

/**
 * 既定の送り方と、出す選択肢。**着手の形か、間があいて大きい（`coldAndLarge()`。#761）ときに、要約できるなら要約が既定**、
 * それ以外はそのまま。どちらでもなくても `warnTokens`（#441 の警告の区切り）を超えていれば要約を横に出す（既定はそのまま）。
 * 新しいセッションは既定にしない（Claude のときだけ出す。まっさらが要るときに人が選ぶ）。
 * **画面からの送信・`sai_send`・待ちで起こすとき（#732）の 3 つが、この 1 つを見る**
 */
export function sendModes(input: SendModeInput, warnTokens: number): { mode: SendMode; choices: SendMode[] } {
  const claude = input.agent === 'claude'
  const compactable = canCompact(input)
  const work = startsNewWork(input.text)
  const cold = coldAndLarge(input)
  const offerCompact = compactable && (work || cold || input.contextTokens >= warnTokens)
  const choices: SendMode[] = offerCompact ? ['compact', 'plain'] : ['plain']
  if (claude && (offerCompact || work)) choices.push('new')
  // 分岐（#405 / #398）は既定にしない。Codex・OpenCode で分岐できるときに、そのままの横に出すだけ
  if ((input.agent === 'codex' || input.agent === 'opencode') && input.forkable && !input.terminal) choices.push('fork')
  return { mode: offerCompact && (work || cold) ? 'compact' : 'plain', choices: choices.length > 1 ? choices : [] }
}

/**
 * 別のセッションからのメッセージ（`sai_send`。#624）・待ちで起こすターン（#732）を、要約してから始めるか。
 * **画面からの送信と同じ判定**（`sendModes()`）で、着手の形の本文か、間があいて大きい相手（#761）で、要約できるときだけ。
 * `input.text` は**送り元が書いた文そのもの**（見出しを付ける前）を渡す。
 * 送る側の指定（`asked`）があれば指定が勝つが、要約できない相手（端末で開いている・Claude でない・文脈が小さい）は指定しても要約しない
 */
export function messageCompacts(input: SendModeInput, warnTokens: number, asked?: boolean): boolean {
  if (asked === false) return false
  if (asked === true) return canCompact(input)
  return sendModes(input, warnTokens).mode === 'compact'
}

/** 着手の形でない本文を `/compact` の指示に写す長さ（頭から。改行は空白に畳む） */
export const COMPACT_HEAD_CHARS = 200

/**
 * `/compact` に添える指示（サーバが 1 か所で持つ）。
 * - **着手の形**（`startsNewWork()`）: 次に取りかかることは本文の 1 行目から。前の作業の細部は捨てさせる（新しい作業に要らない）
 * - **着手の形でない本文**（質問・「マージして」・待ちの結果。#761 で、間があいて大きい相手にはこれも要約が既定になった）:
 *   このあと届くのはいまの作業の続きなので、**直近の作業で変えた箇所・決めたこと・分かったことは残させる**
 *   （着手の指示のまま当てると、「どこをどう変えたか」と聞く前に、答えに要る細部を捨てさせてしまう）
 */
export function compactPrompt(text: string): string {
  const keep = 'リポジトリの決まり・ユーザーの好み・まだ終わっていない約束'
  if (startsNewWork(text)) {
    const next = (text.split('\n')[0] ?? '').trim().slice(0, 200)
    return `/compact 次は「${next}」に取りかかる。終わった作業の細部（差分・ログ・やりとり）は捨て、${keep}だけを残す`
  }
  const head = text.trim().replace(/\s+/g, ' ').slice(0, COMPACT_HEAD_CHARS)
  return `/compact このあと「${head}」というメッセージが届く。それに答える・続けるのに要るもの（直近の作業で変えた箇所・決めたこと・分かったこと）と、${keep}は残す。それより前の作業の細部（差分・ログ・やりとり）は捨てる`
}
