// 引き継いで新しいセッション（#442）。大きくなったセッションに引き継ぎを書かせ、その返答を最初の入力にして新しいセッションを始める。
// **引き継ぎの文面はエージェントに書かせる**（SAI は transcript を要約しない。一言の口とも混ぜない）。
// サーバは「引き継ぎを頼んだ」ことを覚えない: 最後のターン完了の行の入力がこの依頼文なら「引き継ぎが書けている」と読む
// （画面を閉じても・サーバを立て直しても、行から同じ判定になる）。DOM にもプロセスにも触らない純粋関数。handoff.test.ts で回す
import { eventKind } from './events.ts'
import type { FeedRow } from './types.ts'

/** 依頼文の 1 行目。行の `user_text` がこれで始まっていれば引き継ぎの依頼（判定はこの 1 行だけで見る） */
export const HANDOFF_MARK = '【引き継ぎ】次のセッションに引き継ぐための文を書いてください。'

/**
 * 引き継ぎを書かせる依頼文（固定）。行の本文の上限（`record.py` の 20000 字）で切られるので、長さも頼む
 */
export const HANDOFF_PROMPT = [
  HANDOFF_MARK,
  '',
  'この会話はここで終わりにして、新しいセッションで続きをします。新しいセッションはこの会話を読めないので、この返答だけで続きができるように書いてください。',
  '',
  '- いま何をしているか（目的と、どこまで終わったか）',
  '- 決まっていること（決めた方針・守る決まり・やらないと決めたこと）',
  '- まだ決まっていないこと・人の返事を待っていること',
  '- 次に何をするか（順に）',
  '',
  'ファイル名、ブランチ名、issue / PR の番号は省略しないでください。作業はせず、書くだけにしてください。15000 字を超えると切られるので、それより短く。',
].join('\n')

/** その入力が引き継ぎの依頼か */
export function isHandoffPrompt(userText: string | undefined): boolean {
  return (userText ?? '').trimStart().startsWith(HANDOFF_MARK)
}

/**
 * そのセッションの行から、書けている引き継ぎを取る。**最後のターン完了の行**の入力が依頼文で、返答が空でないときだけ。
 * あとから別のターンが回っていれば（人が直しを頼んだ・作業を続けた）null——古い引き継ぎで始めない
 */
export function handoffReady(rows: readonly Pick<FeedRow, 'ts' | 'event' | 'text' | 'user_text'>[]): { ts: string; text: string } | null {
  let last: Pick<FeedRow, 'ts' | 'event' | 'text' | 'user_text'> | null = null
  for (const r of rows) {
    if (eventKind(r.event, r.text) !== 'turn') continue
    if (!last || Date.parse(r.ts) >= Date.parse(last.ts)) last = r
  }
  if (!last || !isHandoffPrompt(last.user_text)) return null
  const text = (last.text ?? '').trim()
  return text ? { ts: last.ts, text } : null
}

/** 新しいセッションの最初の入力。引き継ぎの本文の前に、何であるかを 1 段落添える */
export function handoffFirstText(text: string): string {
  return `前のセッションからの引き継ぎです。以下を読み、まず状況（ブランチ・作業ツリー・挙がっている issue / PR）がこのとおりかを確かめてから、「次に何をするか」の最初から続けてください。\n\n${text}`
}
