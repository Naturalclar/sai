// 一言（digest）の出来を機械で確かめる（#346）。**LLM は呼ばない純粋関数**なので、作るとき
// （server/digest/digest.ts が 1 回だけ作り直す）と、テスト・画面が同じ判定を使える。
//
// 見るのは「元の本文と突き合わせれば分かる食い違い」だけで、良し悪しは判定しない。
// 手元の実データ（一言 667 件）では 13.8% が引っかかった（口が qwen3:8b なら 17.6%、haiku なら 6.2%）。
import { DIGEST_MAX_CHARS } from './persona.ts'

export type DigestIssueCode = 'empty' | 'too_long' | 'quoted_request' | 'prefix' | 'meta_reply' | 'invented_number'

export interface DigestIssue {
  code: DigestIssueCode
  /** 人にも LLM にも見せる短い理由。作り直しのプロンプトにそのまま入る */
  hint: string
}

/**
 * 本文の中で**人が言う言葉として引用された依頼**（`「マージして」と言ってください`）の中身。
 * 引用符の付いているものだけを拾う（引用が無い依頼まで見ると、普通の指示文に当たってしまう）
 */
const QUOTED_REQUEST = /[「『"'`]([^」』"'`\n]{2,30})[」』"'`]\s*と(?:言|伝え)/g

/** 引用の終わり・始まりの記号 */
const QUOTES = '「『"\'`」』'

/** 要約せずプロンプトに答えてしまった文（本文が短すぎるとき、小さいモデルが「本文をください」と返す） */
const META_REPLY = /(いただけますか|いただけると|提示してください|入力してください|返答文|どのテキスト|言い換える(?:文|テキスト))/

/** `一言:` のような前置き */
const PREFIX = /^\s*(?:一言|要約|出力|回答|結果)\s*[:：]/

/** 一言の中の issue / PR の番号（`#123`、`PR 123`、`PR 〈123〉`） */
const SUMMARY_NUMBER = /#(\d{1,6})|(?:PR|Issue|issue|pull)\s*[#〈]?(\d{1,6})[〉]?/g

/** 本文の中の引用された依頼を、出てきた順に返す（同じものは 1 つ） */
export function quotedRequests(source: string): string[] {
  const out = new Set<string>()
  for (const m of source.matchAll(QUOTED_REQUEST)) if (m[1]) out.add(m[1].trim())
  return [...out]
}

/** その位置の語が引用符で囲まれているか（一言の中で引用のまま残っていれば意味は変わらない） */
function quotedAt(summary: string, at: number, len: number): boolean {
  const before = summary.charAt(at - 1)
  const after = summary.charAt(at + len)
  return QUOTES.includes(before) || QUOTES.includes(after)
}

/**
 * 引用された依頼が、エージェントからの問いかけに化けていないか（#346 のきっかけ）。
 *
 * 本文「よければ `「マージして」と言ってください`」→ 一言「… マージして？」は、読む側の動作が変わる。
 * **引用のまま残っていれば見逃す**し、**問いかけになっていなければ見逃す**（引用符が落ちただけの
 * 「#168に着手して」は意味がほぼ変わらないので、ここでは咎めない）
 */
function questionedRequest(source: string, summary: string): string | null {
  for (const phrase of quotedRequests(source)) {
    let at = summary.indexOf(phrase)
    while (at >= 0) {
      if (!quotedAt(summary, at, phrase.length)) {
        // 直後（数文字）に「？」が来ていれば問いかけになっている（`マージして？` / `マージしていい？`）
        const tail = summary.slice(at + phrase.length, at + phrase.length + 8)
        if (/[?？]/.test(tail)) return phrase
      }
      at = summary.indexOf(phrase, at + 1)
    }
  }
  return null
}

/** 本文に出てこない番号（#268 の裏返し。あちらは表示でリンクにしない、こちらは文そのものを直させる） */
function inventedNumbers(source: string, summary: string): string[] {
  const out = new Set<string>()
  for (const m of summary.matchAll(SUMMARY_NUMBER)) {
    const n = m[1] ?? m[2]
    if (n && !source.includes(n)) out.add(n)
  }
  return [...out]
}

/**
 * 一言と元の本文を突き合わせて、直すべき点を返す。空なら文句なし。
 * 並びは直してほしい順（意味が変わるもの → 形の問題）
 */
export function digestIssues(source: string, summary: string): DigestIssue[] {
  const out: DigestIssue[] = []
  const text = summary.trim()
  if (!text) return [{ code: 'empty', hint: '一言が空です' }]

  const phrase = questionedRequest(source, text)
  if (phrase) {
    out.push({
      code: 'quoted_request',
      hint: `本文では「${phrase}」は**人に言ってほしい言葉として引用**されています。問いかけ（「${phrase}？」）に変えず、引用のまま残してください`,
    })
  }
  const invented = inventedNumbers(source, text)
  if (invented.length > 0) {
    out.push({ code: 'invented_number', hint: `本文に出てこない番号（${invented.map((n) => `#${n}`).join(', ')}）を書かないでください` })
  }
  if (META_REPLY.test(text)) {
    out.push({ code: 'meta_reply', hint: '本文を言い換えた一言だけを書いてください（本文を要求したり、やり方を説明したりしない）' })
  }
  if (PREFIX.test(text) || (QUOTES.includes(text.charAt(0)) && QUOTES.includes(text.charAt(text.length - 1)))) {
    out.push({ code: 'prefix', hint: '「一言:」のような前置きや、全体を囲む引用符を付けないでください' })
  }
  const length = [...text].length
  if (length > DIGEST_MAX_CHARS) {
    out.push({ code: 'too_long', hint: `${length} 文字ありました。${DIGEST_MAX_CHARS} 文字以内にしてください` })
  }
  return out
}
