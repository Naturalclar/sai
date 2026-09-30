// 「着手して」は要約（/compact）してから始める（#579）。どの送り方を既定にするか・何を出すかの判定と、要約に添える指示。
// DOM にもプロセスにも触らない純粋関数なので、画面（ReplyBox）とサーバ（POST reply の compact）が同じものを見る。compact.test.ts で回す。
//
// 実データ（9/16〜9/30 の SAI が起こした Claude のターン）で、トークンの 97.3% が会話の読み直しだった。自動の要約は
// 文脈がほぼ満杯（約 97 万）になるまで走らず、要約すれば約 8 万に落ちる。新しい作業に取りかかる前に 1 回要約する

/** これより小さいセッションは要約しない（新しいセッションの最初は約 4.9 万・要約の直後は約 8.3 万で、得るものが無い） */
export const COMPACT_MIN_TOKENS = 150_000

/** 返信の送り方。`compact` = 要約してから送る、`plain` = そのまま、`new` = 新しいセッションで送る */
export type SendMode = 'compact' | 'plain' | 'new'

export const SEND_MODE_LABEL: Record<SendMode, string> = {
  compact: '要約してから送る',
  plain: 'そのまま送る',
  new: '新しいセッションで送る',
}

/**
 * 1 行目が「着手して」の形か。**狭い方に倒す**（着手でない文を要約してから送る方が害が大きい。取りこぼしたら人が選べばよい）。
 * 実データ（人の入力 1,800 回）で 1 行目が着手の形だったのは 215 回: `着手して` / `N着手して` / `Nに着手して` / `N対応して` / `Nを着手して`。
 * 番号の前の `#`、後ろの `ください`・句点・感嘆符は許す。`修正も着手して`・`かなでのセッションでN着手` のような形は当てない（続きに送るだけ）
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
}

/** 要約を選べるか。Claude で、端末で開いておらず、下限以上のとき（量が分からなければ出さない） */
export function canCompact(input: Pick<SendModeInput, 'agent' | 'contextTokens' | 'terminal'>): boolean {
  return input.agent === 'claude' && !input.terminal && input.contextTokens >= COMPACT_MIN_TOKENS
}

/**
 * 既定の送り方と、出す選択肢。**着手の形で要約できるなら要約が既定**、それ以外はそのまま。
 * 着手でなくても `warnTokens`（#441 の警告の区切り）を超えていれば要約を横に出す（既定はそのまま）。
 * 新しいセッションは既定にしない（Claude のときだけ出す。まっさらが要るときに人が選ぶ）
 */
export function sendModes(input: SendModeInput, warnTokens: number): { mode: SendMode; choices: SendMode[] } {
  const claude = input.agent === 'claude'
  const compactable = canCompact(input)
  const work = startsNewWork(input.text)
  const offerCompact = compactable && (work || input.contextTokens >= warnTokens)
  const choices: SendMode[] = offerCompact ? ['compact', 'plain'] : ['plain']
  if (claude && (offerCompact || work)) choices.push('new')
  return { mode: offerCompact && work ? 'compact' : 'plain', choices: choices.length > 1 ? choices : [] }
}

/**
 * `/compact` に添える指示（サーバが 1 か所で持つ）。次に取りかかることは本文の 1 行目から
 */
export function compactPrompt(text: string): string {
  const next = (text.split('\n')[0] ?? '').trim().slice(0, 200)
  return `/compact 次は「${next}」に取りかかる。終わった作業の細部（差分・ログ・やりとり）は捨て、リポジトリの決まり・ユーザーの好み・まだ終わっていない約束だけを残す`
}
