// 「次に送る文面の案」（next_ask）が**人の返信として読めるか**を機械で確かめる（#729）。**LLM は呼ばない純粋関数**。
//
// 実測（2026-10-05〜10-07 の案 92 件。口は手元の小さいモデル）で、案の 64% がエージェントの側の文だった:
// 本文の最後の問いをそのまま聞き返す（27%）・エージェントが次にやると言ったことを宣言する（26%）・人への頼みを頼み返す（11%）。
// 小さいモデルは直前に読んだ本文の声に引っ張られる。一言には `digestIssues()` があるのに、案には確かめが無かった。
// 見るのは**文末の形と、本文の文との近さ**だけで、中身の良し悪しは判定しない。
// 人が頼んだこと（`user_text`）は見ない（頼みごとは必ず「〜して」の形なので、混ぜると判定が狂う。一言と同じ決まり）。
import { proseSentences } from './digestCheck.ts'

export type NextAskIssueCode =
  // エージェントの宣言の形（「〜します」。「〜しました」は本文の報告を写したときだけ）。人がエージェントに向かって言う文ではない
  | 'declaration'
  // エージェントから人への問いの形（「〜しますか？」）か、本文の問いをそのまま聞き返している
  | 'question_back'
  // 本文で人に頼んでいることを、そのまま頼み返している（「〜を教えてください」）
  | 'request_back'
  // 本文の文をほぼそのまま写している（報告の文など）
  | 'copy'

export interface NextAskIssue {
  code: NextAskIssueCode
  /** 人にも LLM にも見せる短い理由。作り直しのプロンプトにそのまま入る */
  hint: string
}

export const NEXT_ASK_ISSUE_LABELS: Record<NextAskIssueCode, string> = {
  question_back: 'エージェントの問いの形（聞き返し）',
  declaration: 'エージェントの宣言の形（〜します）',
  request_back: '人への頼みの形（頼み返し）',
  copy: '本文の写し',
}

/** 同じ形の本文の文と、ここまで近ければ「写した」とみなす（文字の 2 つ組の重なり。0〜1） */
export const NEXT_ASK_SAME_FORM = 0.6
/** 形が違っても、ここまで近ければ本文の写し */
export const NEXT_ASK_COPY = 0.85

/** 末尾の記号・絵文字・空白を落とす（文末の形を見るため） */
const tailOf = (text: string): string => text.replace(/[\s\p{P}\p{S}]+$/u, '')

/** 問いかけの形か（疑問符で終わる・「〜か」で終わる丁寧な問い） */
function isQuestion(text: string): boolean {
  return /[?？][\s\p{P}\p{S}]*$/u.test(text) || /(?:ますか|ですか|でしょうか|ましょうか)$/.test(tailOf(text))
}

/**
 * エージェントが人に伺う問いの形（「〜しますか」「〜しましょうか」「〜でよろしいですか」）。
 * 人がエージェントに聞く問い（「なぜ落ちた？」「原因は何ですか」）は当てない
 */
const OFFER = /(?:ますか|ましょうか|でしょうか|よろしいですか|いいですか)$/
/**
 * 「〜ますか」で終わるが、人がエージェントに言う文: 丁寧な頼み（「〜してもらえますか」）と、有無・可否を聞く問い（「〜はありますか」）。
 * 伺いの形とは数えない（本文の頼み・問いを写していないかだけを見る。#736 のレビュー）
 */
const POLITE_ASK = /(?:[てで](?:もらえ|いただけ|くれ)ますか|お願いできますか|ありますか|できますか|いますか|なりますか|[わ分]かりますか)$/

/** 宣言の形（「〜します」）。エージェントが次にやることを言う形で、人がエージェントに向かって言う文ではない */
const DECLARATION = /(?:ます|ますね|ますよ|ますので|予定です|ところです)$/
/**
 * 済んだことを言う形（「〜しました」）。**本文の文と近いときだけ**宣言と数える（エージェントの報告を写したもの）。
 * 本文に無い「〜しました」は、頼まれたことを済ませた人の返事（「確認しました」「鍵を置きました」）なので通す（#736 のレビュー）
 */
const DONE = /(?:ました|ましたね|ましたよ)$/
/**
 * 「〜ます」で終わるが、人がエージェントに言う文（頼み・礼・感想・**選択肢への答え**）。
 * 「〜を選びます」「〜にします」は、選択肢を示されたときの人の答えの形（比べたとき、選んだ案がここで落ちていた）
 */
const DECLARATION_OK = /(?:お願い(?:いた)?します|お願いできます|頼みます|助かります|ありがとうございます|思います|気になります|困ります|任せます|選びます|選択します|にします)$/

/** 頼みの形（「〜してください」「〜してもらえますか」「〜して」）。本文の頼みを写したかを見るときだけ使う */
const REQUEST_FORM = /(?:[てで](?:ください|下さい)|[てで](?:もらえ|いただけ|くれ)ますか|お願い(?:いた)?します|お願いできますか|[てで])$/
/** 本文の側の、人への頼みの文（「〜してください」「〜してもらえますか」）。「〜して」だけの文は頼みと数えない */
const SOURCE_REQUEST = /(?:[てで](?:ください|下さい)|[てで]もらえ(?:ますか|れば)|[てで]いただけ|お願い(?:いた)?します|お願いできますか)/

/** 箇条書き・番号つき・表の行（選択肢が並ぶ所）。ここの文言をそのまま選んだ答えは、写しと数えない */
const LIST_LINE = /^\s*(?:[-*+]\s|\d+[.)]\s|\|)/

/** 文末の頼みの言い回しを落としたもの（「実機で確認してもらえますか？」→「実機で確認し」） */
const requestStem = (text: string): string => tailOf(text).replace(/(?:[てで](?:ください|下さい|(?:もらえ|いただけ|くれ)ますか)?|お願い(?:いた)?します|お願いできますか)$/, '')

/** 比べる前に、空白と記号を落として揃える */
const squash = (text: string): string => text.normalize('NFC').replace(/[\s\p{P}\p{S}]+/gu, '')

/** 文字の 2 つ組の重なり（Dice。0〜1）。どちらかが 2 文字未満なら、同じ文字列のときだけ 1 */
export function similarity(a: string, b: string): number {
  const x = squash(a)
  const y = squash(b)
  if (x.length < 2 || y.length < 2) return x !== '' && x === y ? 1 : 0
  const grams = (s: string) => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1)
    return m
  }
  const gx = grams(x)
  const gy = grams(y)
  let shared = 0
  for (const [g, n] of gx) shared += Math.min(n, gy.get(g) ?? 0)
  return (2 * shared) / (x.length - 1 + y.length - 1)
}

const closest = (text: string, sentences: readonly string[]): number => sentences.reduce((max, s) => Math.max(max, similarity(text, s)), 0)

/**
 * 案と本文を突き合わせて、人の返信として読めない点を返す。空なら文句なし。**空の案は何も言わない**（出さないだけ）。
 *
 * 形ごとに見る順は 問い → 宣言 → 頼み → 写し で、最初に当たった 1 つだけを返す（同じ文を 2 つの理由で数えない）。
 * 本文の問いを指示に直した文（「〜しますか？」→「〜して」）は、本文の問いと字面が近くても咎めない
 * （形が変わっていれば、人の返信になっている）
 */
export function nextAskIssues(rawNextAsk: string, rawText: string): NextAskIssue[] {
  const ask = (rawNextAsk ?? '').normalize('NFC').trim()
  if (!ask) return []
  const tail = tailOf(ask)
  const sentences = proseSentences(rawText ?? '')
  const requests = sentences.filter((s) => SOURCE_REQUEST.test(s))
  const QUESTION_BACK: NextAskIssue = { code: 'question_back', hint: 'これは**エージェントが人に聞く問い**の形です。問いを繰り返さず、**問いへの答えか、エージェントへの指示（「〜して」）**を書いてください' }
  const REQUEST_BACK: NextAskIssue = { code: 'request_back', hint: 'これは**エージェントがあなたに頼んでいること**をそのまま返しています。頼まれたことをエージェントに頼み返さず、あなたからの返事か指示を書いてください' }
  const DECLARED: NextAskIssue = { code: 'declaration', hint: 'これは**エージェントが言う宣言**（「〜します」「〜しました」）の形です。あなたは頼む側なので、**エージェントへの指示（「〜して」）**の形で書いてください' }
  // 頼みの言い回し（「〜してください」「〜してもらえますか」）を外した中身で比べる（言い回しだけ変えた頼み返しを拾う）
  const mirrorsRequest = REQUEST_FORM.test(tail) && closest(requestStem(ask), requests.map(requestStem)) >= NEXT_ASK_SAME_FORM
  if (isQuestion(ask)) {
    // 丁寧な頼みの形の問い（「〜してもらえますか」）は、本文の頼みを写したときだけ頼み返し
    if (mirrorsRequest) return [REQUEST_BACK]
    const offer = OFFER.test(tail) && !POLITE_ASK.test(tail)
    return offer || closest(ask, sentences.filter(isQuestion)) >= NEXT_ASK_SAME_FORM ? [QUESTION_BACK] : []
  }
  if (DECLARATION.test(tail) && !DECLARATION_OK.test(tail)) return [DECLARED]
  if (DONE.test(tail) && closest(ask, sentences) >= NEXT_ASK_SAME_FORM) return [DECLARED]
  if (mirrorsRequest) return [REQUEST_BACK]
  // 写しは、箇条書き・表の行（選択肢）を除いた文とだけ比べる（選択肢の文言をそのまま選んだ答えを落とさない。#736 のレビュー）
  const prose = proseSentences(
    (rawText ?? '')
      .split('\n')
      .filter((line) => !LIST_LINE.test(line))
      .join('\n'),
  )
  if (closest(ask, prose) >= NEXT_ASK_COPY) {
    return [{ code: 'copy', hint: '本文の文をそのまま写しています。エージェントの文を写さず、**あなたが次に送る文**を書いてください' }]
  }
  return []
}
