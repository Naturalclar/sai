// 一言（digest）の出来を機械で確かめる（#346）。**LLM は呼ばない純粋関数**なので、作るとき
// （server/digest/digest.ts が 1 回だけ作り直す）と、テスト・画面が同じ判定を使える。
//
// 見るのは「元の本文と突き合わせれば分かる食い違い」だけで、良し悪しは判定しない。
// 手元の実データ（一言 667 件）では 13.8% が引っかかった（口が qwen3:8b なら 17.6%、haiku なら 6.2%）。
import { DIGEST_MAX_CHARS } from './persona.ts'

export type DigestIssueCode =
  | 'empty'
  | 'too_long'
  | 'quoted_request'
  | 'prefix'
  | 'meta_reply'
  | 'invented_number'
  // 本文に無いことを足したもの（#363）。#268 / #346 と同じ「本文に書いてあることだけ」の系列
  | 'invented_request'
  // 落ちているもの（#359）。意味は変わっていないが、読んだ人が次に何をすればよいか分からなくなる
  | 'dropped_request'
  | 'waiting_without_next'
  | 'bare_number'

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

/**
 * 本文の中の「人にしてほしいこと」（#359）。エージェントが人に頼んでいる形だけを見る。
 * ` ``` ` の中（貼られたコマンドや設定）は見ない（本文としての依頼ではないため）
 */
const REQUEST = /(?:て(?:ください|下さい)|てもらえ(?:ますか|れば)|お願いします|お願いできますか|していただけ)/

/**
 * 本文が「人がすること」に触れているか（#363）。`REQUEST` より広く、**頼みの形になっていない**
 * 言い方（`〜する必要があります`、`〜したほうが確実です`、`マージしますか。`）も含める。
 *
 * ここに当たらない本文は「報告だけ」とみなす。**当たるかどうかだけを見て、内容は見ない**ので、
 * 広く取りこぼさない方に倒してある（報告だけと誤って決めつけると、正しい一言を作り直させてしまう）
 */
const SOURCE_NEXT = /(ますか|ますね|でしょうか|どちら|いかが|ください|下さい|お願い|いただけ|てもらえ|てほし|て欲し|必要があ|必要です|要ります|要る|といい|ほうが|方が|おすすめ|推奨|ましょう|お試し|[?？])/

/**
 * 一言が**人に何かを求めている**形か（#363）。`NEXT_WORDS` より狭く、
 * **誘い（「〜しよう」「〜しましょう」）は数えない**（口調の指示にその言い回しがあり、
 * 自分の次の一手としても使うので、人への頼みと区別が付かない）
 */
const INVENTED_ASK = /(ください|下さい|てね|でね|お願いし|よろしく|言って|てみて|[?？])/

/** 一言が「人が次にすること」に触れているか（頼み・問いかけ・誘いの言葉） */
const NEXT_WORDS = /(ください|下さい|てね|でね|お願い|よろしく|言って|てみて|どう(?:です)?か|[?？])/

/**
 * 末尾が依頼・誘いの形か（`…確認して 🚀`、`…更新しましょう`、`…進めよう！`）。
 * 口語の一言は「〜して」で終わって頼むことが多いので、末尾の記号と絵文字を落としてから見る
 */
function endsWithRequest(summary: string): boolean {
  const tail = summary.replace(/[\s\p{P}\p{S}]+$/u, '')
  return endsWithTe(summary) || /(?:よう|ましょう)$/u.test(tail)
}

/** 末尾が「〜して」「〜で」（頼みの形。誘いは含まない）。記号と絵文字を落としてから見る */
function endsWithTe(summary: string): boolean {
  return /[てで]$/u.test(summary.replace(/[\s\p{P}\p{S}]+$/u, ''))
}

/** 一言が人に何かを求めているか（#363。作り話かを見るので、誘いは数えない） */
function asksPerson(summary: string): boolean {
  return INVENTED_ASK.test(summary) || endsWithTe(summary)
}

/** 一言が「人が次にすること」に触れているか */
function hasNextAction(summary: string): boolean {
  return NEXT_WORDS.test(summary) || endsWithRequest(summary)
}

/** 一言が「待っている」と言っているか */
const WAITING = /(待って|待ち|待機)/

/**
 * 待ちが終わったらどうなるかに触れているか（`通ったら…`、`終わったら…`、`次は…`）。
 * **本文に「人がすること」が書かれていない回もある**（「通ったら私がマージします」だけ、など）。
 * そこで人への頼みが無くても、**終わったらどうなるか**が書いてあれば咎めない（本文に無いことは書かせない。#268 / #359）
 */
const AFTER_WAIT = /(たら|れば|次は|そのあと|あとで)/

/** ` ``` ` で囲まれた塊を外す（依頼の判定に、貼られたコマンドを混ぜない） */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, ' ')
}

/**
 * 本文から、依頼の判定に混ぜたくないもの（コードブロック・その場のコード・URL）を外す。
 * URL の `?` を問いかけと数えないためにも要る
 */
function plain(text: string): string {
  return withoutCode(text).replace(/`[^`\n]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ')
}

/** 一言の中の issue / PR の番号（`#123`、`PR 123`、`PR 〈123〉`） */
const SUMMARY_NUMBER = /#(\d{1,6})|(?:PR|Issue|issue|pull)\s*[#〈]?(\d{1,6})[〉]?/g

/**
 * 番号のあとに続く言葉が**動作の語だけ**か（`#76 作成`、`PR #73 マージ完了`）。
 * これだけでは「何の番号なのか」が分からない（#363）
 */
const ACTION_ONLY = /^(?:[をはもがのにとで、\s]|自動)*(?:作成|作った|作りまし|立て|マージ|merge|squash|閉じ|クローズ|close|完了|対応|着手|更新|修正|追加|公開|出し|上げ|オープン|open|提出|反映|解決|済み|完成|実施|実行)/

/** 番号のあとの、次の区切りまでの言葉 */
function segmentAfter(text: string, at: number): string {
  return (text.slice(at).split(/[、。！!？?・\n]|\s—|,\s/)[0] ?? '').trim()
}

/**
 * 番号のあとの言葉が「何をするものか」を言っているか。
 * 動作の語だけ（`マージ完了`）と、**番号が並んでいるだけ**（`/ #77 / #78 を立てました`）は説明ではない
 */
function explainsNumber(after: string): boolean {
  const rest = after.replace(SUMMARY_NUMBER, ' ').replace(/^[\s/・,、と–—-]+/, '').trim()
  return rest !== '' && !ACTION_ONLY.test(rest)
}

/**
 * 本文がその番号の**題名**を書いているか（#363）。`#78 仕様書…を更新する` のように、
 * 番号のすぐ後ろに中身が続いている形だけを取り、`#79 を squash マージしました` のような
 * **地の文（助詞で続くもの）は題名と数えない**（写せる説明が本文に無いのに作り直させないため）。
 * 見つかればその題名（作り直しの理由にそのまま入れる）を返す
 */
export function numberTitle(source: string, n: string): string | null {
  const m = new RegExp(`(?:#|PR\\s*#?|Issue\\s*#?|issue\\s*#?)${n}[ 　:：]+([^\\n]{4,80})`).exec(source)
  if (!m) return null
  const raw = m[1]!.trim()
  if (/^(?:を|は|が|も|に|で|と|の|へ|から|や|、|。)/.test(raw)) return null
  const title = raw.replace(/https?:\/\/\S+/g, ' ').replace(/[*_`[\]()]/g, ' ').trim()
  return title.length >= 6 && /[ぁ-んァ-ヶ一-龠A-Za-z]{4,}/.test(title) ? title.slice(0, 60) : null
}

/**
 * 一言の中の番号が、どれも「何をするものか」抜きで置かれているか（#363）。
 * **本文に題名がある番号だけ**を返す（本文から分からなければ番号だけでよい、が元の規則）。
 * 一言の中のどれか 1 つでも説明が付いていれば、残りは番号だけでよい（80 字に全部は入らない）
 */
function bareNumbers(source: string, summary: string): string[] {
  const bare: string[] = []
  for (const m of summary.matchAll(SUMMARY_NUMBER)) {
    const n = m[1] ?? m[2]
    if (!n) continue
    if (explainsNumber(segmentAfter(summary, m.index + m[0].length))) return [] // 説明の付いた番号が 1 つあればよい
    const title = numberTitle(source, n)
    if (title) bare.push(`#${n}（${title}）`)
  }
  return bare
}

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

/**
 * 本文に出てこない番号（#268 の裏返し。あちらは表示でリンクにしない、こちらは文そのものを直させる）。
 * **人が頼んだこと（`ask`）にある番号も裏付けと数える**（#376。`#371 に着手して` と頼まれた回で
 * 一言が `#371` を書くのは作り話ではない）
 */
function inventedNumbers(source: string, summary: string, ask: string): string[] {
  const out = new Set<string>()
  for (const m of summary.matchAll(SUMMARY_NUMBER)) {
    const n = m[1] ?? m[2]
    if (n && !source.includes(n) && !ask.includes(n)) out.add(n)
  }
  return [...out]
}

/**
 * 一言と元の本文を突き合わせて、直すべき点を返す。空なら文句なし。
 * 並びは直してほしい順（意味が変わるもの → 形の問題）
 */
export function digestIssues(rawSource: string, rawSummary: string, rawAsk = ''): DigestIssue[] {
  const out: DigestIssue[] = []
  // 実データには NFD（`く`+濁点 で `ぐ`）の本文が混じっていて、そのままだと「ください」が
  // どの正規表現にも当たらず、判定が丸ごと素通りする（手元の 735 件中 7 件）
  const source = rawSource.normalize('NFC')
  const text = rawSummary.normalize('NFC').trim()
  // 人が頼んだことは**番号の裏付けにだけ**使う（#376）。依頼・題名の判定には混ぜない:
  // 頼みごとは必ず「〜して」の形なので、混ぜると `invented_request` がほぼ鳴らなくなり、
  // 本文に無い説明を頼んだことから写させることにもなる
  const ask = rawAsk.normalize('NFC')
  if (!text) return [{ code: 'empty', hint: '一言が空です' }]
  const body = plain(source)

  const phrase = questionedRequest(source, text)
  if (phrase) {
    out.push({
      code: 'quoted_request',
      hint: `本文では「${phrase}」は**人に言ってほしい言葉として引用**されています。問いかけ（「${phrase}？」）に変えず、引用のまま残してください`,
    })
  }
  const invented = inventedNumbers(source, text, ask)
  if (invented.length > 0) {
    out.push({ code: 'invented_number', hint: `本文に出てこない番号（${invented.map((n) => `#${n}`).join(', ')}）を書かないでください` })
  }
  // 本文は報告だけなのに、一言が人に何かを求めている（#363。実測 735 件中 40 件）。
  // 「特に取るべきことが無いのに『〜して？』と書く」を止める。無ければ無いままでよい
  if (!SOURCE_NEXT.test(body) && asksPerson(text)) {
    out.push({
      code: 'invented_request',
      hint: '本文には**人にしてほしいことも、人への質問も書かれていません**。「〜して？」「〜していい？」のような頼み・問いかけを足さず、何をしたかだけで終えてください',
    })
  }
  // 本文が人に何かを頼んでいるのに、一言がそれを落とした（#359。実測 203 件中 45 件）
  if (REQUEST.test(body) && !hasNextAction(text)) {
    out.push({
      code: 'dropped_request',
      hint: '本文には**人にしてほしいこと**（「〜してください」「〜と言ってください」など）が書かれています。本文の言葉のまま一言にも残してください',
    })
  }
  // 「待っている」で終わっていて、人が次に何をすればよいか分からない（#359。実測 42 件中 38 件）。
  // **本文にその先が書かれているときだけ**言う（#363。書かれていない本文で言うと、作り直しでは
  // 直しようがなく、人への頼みを作る方に押してしまう）
  if (WAITING.test(text) && !hasNextAction(text) && !AFTER_WAIT.test(text) && (SOURCE_NEXT.test(body) || AFTER_WAIT.test(body))) {
    out.push({
      code: 'waiting_without_next',
      hint: '「待っている」だけで終わっています。**何を待っていて、終わったらどうなるか**（本文に人がすることが書いてあれば、その言葉のまま）まで書いてください',
    })
  }
  // 番号だけが置かれていて、本文には題名があるのに何の番号か分からない（#363。実測 564 件中 54 件）
  const bare = bareNumbers(source, text)
  if (bare.length > 0) {
    out.push({
      code: 'bare_number',
      hint: `番号だけでは何のことか分かりません。本文にある説明（${bare.join(', ')}）を、主なもの 1 つだけでよいので短く添えてください`,
    })
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
