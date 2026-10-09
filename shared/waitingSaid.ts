// 「待ちます」と言って終わったターンを見つける（#732 の案 3）。**LLM は呼ばない純粋関数**。
//
// エージェントが「CI が通ったらマージします」「結果が届き次第、続けます」と言ってターンを終えても、待ち（`sai_wait_for`）を
// 預けていなければ、起こすものは無い。人が見に行くまで止まる。その返答に印を付けて、人が待ちを置けるようにする。
//
// 文面の判定なので、**分からないときは出さない**:
// - 見るのは返答の末尾だけ（途中の「待ちます」は、そのあとで片付いていることが多い）
// - **人を待っている文は数えない**（「『マージして』を待ちます」「ご指示を待ちます」。起こす相手は人で、SAI が起こせるものではない）
// - **機械が終わるもの**（CI・テスト・ビルド・レビュー・結果…）の話をしている文だけ数える（その文か、すぐ前の文に出てくること。
//   「403 が出たら README を見ます」「返答が届いたら同じ並びに出します」のような、待ちではない「〜たら」を拾わない）
// - コードブロックと引用の中は見ない

/** 末尾として見る行の数（空でない行）と、その字数の上限 */
export const WAITING_TAIL_LINES = 4
export const WAITING_TAIL_CHARS = 400
/** これより前に終わったターンには印を出さない（古い「待ちます」は、もう別の形で片付いていることが多い） */
export const WAITING_SAID_FRESH_MS = 12 * 3600_000
/** 人が画面から置く待ちの「起きたらやること」（決まった文。マージはさせない） */
export const WAIT_HUMAN_THEN = 'CI の結果を読んで報告する（マージはしない）'

// 「待つ」と言っている形。機械が終わるのを待つ言い方だけ（「お待ちください」のような、人への声かけは入れない）
const WAITS = [
  /待ちます/,
  /待っています/,
  /待ってから/,
  /待機します/,
  /待機中です/,
  /(届き|終わり|完了し|通り|出|揃い|そろい)次第/,
  /(完了|終了)次第/,
  /(通っ|終わっ|完了し|緑になっ|届い|揃っ|そろっ|出)たら/,
  /\bwaiting (for|on)\b/i,
  /\bonce (it|they|ci|the ci|the checks?|checks|the review|the tests?|tests)\b[^.]*\b(pass(es)?|finish(es)?|complet(e|es)|land(s)?|is done|are done|is green|are green)\b/i,
  /\bwill (merge|continue|proceed|report|follow up)\b[^.]*\b(when|once|after)\b/i,
]

// 人を待っている文の手がかり（この語がある文は数えない）
const HUMAN = [
  /[「『"“][^」』"”]{1,40}[」』"”]\s*(の指示|の一言|の返事|と言われる)?\s*(を|まで)?\s*(お)?待/,
  /(ご?指示|お?返事|ご?返答|ご?回答|ご?判断|ご?確認|ご?承認|ご?許可|ご?連絡|ゴーサイン|go サイン|レビューコメント)[^。\n]{0,12}(を|まで|が)?[^。\n]{0,6}(お)?待/i,
  /(人|あなた|ユーザー|そちら|オーナー|レビュアー)(の|から|が)[^。\n]{0,20}(お)?待/,
  /(言われ|言ってもらっ|指示があっ|指示をもらっ|頼まれ|決まっ|決めてもらっ|教えてもらっ|返事があっ|返事が来)(たら|次第)/,
  /\bwaiting (for|on) (you|your|the user|a human|approval|confirmation|instructions?|feedback|a reply|the go-ahead)\b/i,
  /\b(let me know|tell me|your call)\b/i,
  // 「『…』と言ってもらえれば」「『…』で〜します」（人の一言が合図）
  /(言ってもらえ|言っていただけ|言ってくれ|伝えてもらえ|声をかけてもらえ)(れば|たら)/,
  /[「『][^」』]{1,40}[」』]\s*(で|なら|と(言|い)(われ|って|えば))/,
]

// 機械が終わるもの。待っている相手がこれの類のときだけ数える
const MACHINE = /CI|チェック|テスト|ビルド|レビュー|結果|一式|ジョブ|ワークフロー|デプロイ|\b(checks?|builds?|reviews?|tests?|workflows?|jobs?|pipeline|suite|deploy(ment)?)\b/i

/** コードブロックと引用の行を落とす */
function prose(text: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced || !line || line.startsWith('>')) continue
    out.push(line)
  }
  return out
}

/** 返答の末尾（空でない行を後ろから数行。長すぎれば後ろの字数だけ） */
export function waitingTail(text: string): string {
  const tail = prose(text).slice(-WAITING_TAIL_LINES).join('\n')
  return tail.length > WAITING_TAIL_CHARS ? tail.slice(-WAITING_TAIL_CHARS) : tail
}

/**
 * 返答の末尾が「〜を待ちます／届き次第／通ったら」の類か。**人を待っている文・機械が終わるものの話でない文しか無ければ false**。
 * 文ごとに見る（「CI が通ったら報告します。マージは『マージして』を待ちます」は、前の文で true）
 */
export function saysWaiting(text: string): boolean {
  const tail = waitingTail(text)
  if (!tail) return false
  const sentences = tail.split(/[。\n！？!?]|\.\s/).filter((x) => x.trim())
  for (const [i, sentence] of sentences.entries()) {
    if (!WAITS.some((re) => re.test(sentence))) continue
    if (HUMAN.some((re) => re.test(sentence))) continue
    if (!MACHINE.test(sentence) && !MACHINE.test(sentences[i - 1] ?? '')) continue
    return true
  }
  return false
}

/** そのセッションで分かっていること（印を出すかを決める材料）。どれも呼ぶ側が集める */
export interface WaitingSaidInput {
  /** 最後の行がターン完了か（人が次に何か打った・待ちの行が来た、なら false） */
  lastIsTurn: boolean
  /** その返答の本文 */
  text: string
  /** そのターンが終わった時刻（ミリ秒） */
  endedMs: number
  now: number
  /** いま処理中・預かりがある（もう次のターンが回っている・回る） */
  busy: boolean
  /** このセッションに置いてある待ちの数（状態は問わない。起こせなかった待ちが残っていても、人はそちらを見る） */
  waits: number
  /** このセッションのブランチから出ている open な PR の番号。**ちょうど 1 つに決まったときだけ**（分からない・2 つ以上は空の配列か複数） */
  prs: readonly number[]
}

/**
 * 「待つと言ったが、起こす予定が無い」の印を出すか。出すならその PR の番号、出さなければ 0。
 * **1 つでも分からなければ出さない**
 */
export function waitingUnscheduled(input: WaitingSaidInput): number {
  if (!input.lastIsTurn || input.busy || input.waits > 0) return 0
  if (!Number.isFinite(input.endedMs) || input.now - input.endedMs > WAITING_SAID_FRESH_MS || input.endedMs > input.now + 60_000) return 0
  if (input.prs.length !== 1) return 0
  return saysWaiting(input.text) ? input.prs[0]! : 0
}
