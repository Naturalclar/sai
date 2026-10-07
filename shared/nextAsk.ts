// 一言（digest）と同じ口・同じタイミングで作る「次に送る文面の案」（#371）。
// エージェント自身が出す入力の候補は SAI に届かない: Claude は候補そのものが transcript にもフックの payload にも
// 書かれず（人が選んだ後に `promptSource: "suggestion_accepted"` が付くだけ）、Codex は提案を作る裏の LLM 呼び出しを
// `record.py` の `is_codex_internal_turn()` が捨てている（セッション ID が無く、同じ cwd の無関係なセッションに紛れ込むため）。
// ここはプロンプトと後始末だけを持ち、口は `server/digest/digest.ts` の `Summarizer` をそのまま使う。
// DOM も node も触らないので `shared/nextAsk.test.ts` を node:test で回す。
import { quotedAsks } from './digestCheck.ts'
import { nextAskIssues } from './nextAskCheck.ts'
import type { NextAskIssue, NextAskIssueCode } from './nextAskCheck.ts'

/**
 * 案の長さの目安（文字）。プロンプトで指示し、超えたぶんは `cleanNextAsk()` が切る。
 * 入力欄の上のチップに 1 行で出すので、一言（`DIGEST_MAX_CHARS` = 80）より短くする
 */
export const NEXT_ASK_MAX_CHARS = 60

/** 作り直しの材料（#729）。`nextAskIssues()` が見つけた点を、そのまま LLM に伝える */
export interface NextAskRetry {
  /** 前に作った案 */
  nextAsk: string
  issues: readonly NextAskIssue[]
}

/**
 * LLM に渡すプロンプト。一言と違って性格（口調）は足さない。
 * **これは人が送る文**で、エージェントの声ではないため（性格を混ぜると、自分が打った覚えのない口調の文が入力欄に入る）。
 * `retry` があれば、前の案と機械で見つけた直してほしい点を足す（#729。`composeNextAsk()` が 1 回だけ使う）。
 *
 * 文末の形で縛る書き方（「指示か、問いへの答え」）も比べたが、確かめと合わせると良くならなかったので入れていない
 * （`server/tools/digest-eval/ask.ts` の `formNextAskPrompt()` に残してある。数字は docs/history/digest.md）
 */
export function nextAskPrompt(userText: string, text: string, opts: { retry?: NextAskRetry } = {}): string {
  const asked = (userText ?? '').trim()
  const { retry } = opts
  const fix = retry ? ['', `前に作った文: ${retry.nextAsk}`, 'この文には次の点がありました。直して作り直してください:', ...retry.issues.map((i) => `- ${i.hint}`)] : []
  return [
    'あなたはコーディングエージェントを使っている人です。直前のやりとりを読んで、**あなたが次に送る文**を 1 つ考えてください。',
    `- 日本語で 1 文、${NEXT_ASK_MAX_CHARS} 文字以内。エージェントへの指示か質問にする`,
    // 一言と同じ理由（#268）。本文に無い番号を書かせない。**作例に具体的な数字や題材を置かない**のも同じ
    // （小さいモデルは作例をそのまま書き写すので、番号の無いターンでもその数字を書いてしまう）
    '- **本文に書かれていることだけ**を材料にする。番号（`#` に続く数字）・ファイル名・コマンドは本文にあるものだけ使い、本文に無い番号は書かない',
    '- **本文にエージェントからの質問や頼みがあれば、それに答える文にする**（最優先。選択肢が示されていればどれかを選ぶ）',
    '- 本文が報告だけで終わっているなら、そこから自然に続く一手にする。本文に出てこない作業を思いつきで足さない',
    '- 出力は文だけ。引用符、「案:」などの前置き、箇条書きの印、2 つ目以降の案は付けない',
    ...fix,
    '',
    '---',
    ...(asked ? ['直前にあなたが送った文:', asked, ''] : []),
    'エージェントの返答:',
    text,
  ].join('\n')
}

/** 引用の囲み。LLM は指示しても案を括ってくることがある */
const WRAPS: readonly (readonly [string, string])[] = [
  ['「', '」'],
  ['『', '』'],
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['“', '”'],
]

/**
 * 出来上がりを入力欄に入れられる形にする。**最初の中身のある行だけ**を採る
 * （前置きや 2 つ目の案が続いても、1 つ目だけを使う）。作れていなければ空を返す（呼び出し側は「無いまま」にする）
 */
export function cleanNextAsk(raw: string): string {
  const body = tidyNextAsk(raw)
  return body.length > NEXT_ASK_MAX_CHARS ? body.slice(0, NEXT_ASK_MAX_CHARS) : body
}

/**
 * `cleanNextAsk()` の、長さで切る前のもの。**確かめ（`nextAskIssues()`）はこちらに当てる**
 * （切ったあとだと文末の形が消えて、長い宣言・聞き返しが素通りする。#736 のレビュー）
 */
export function tidyNextAsk(raw: string): string {
  const line = (raw ?? '')
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s)
  let body = (line ?? '')
    .replace(/^[-*・]\s*/, '')
    .replace(/^\d+[.)、]\s*/, '')
    .replace(/^(案|提案|次に送る文|次)\s*[:：]\s*/, '')
    .trim()
  for (const [open, close] of WRAPS) {
    if (body.length > open.length + close.length && body.startsWith(open) && body.endsWith(close)) {
      body = body.slice(open.length, -close.length).trim()
      break
    }
  }
  return body
}

/**
 * 本文が人に言ってほしい言葉を引用の形で書いていれば（「『〜』と言ってください」）、**その引用をそのまま案にする**（#713）。
 * LLM は呼ばない。見つけ方は `digestCheck.ts` の `quotedAsks()`（一言の確かめの引用の検出を、頼みの形「と言ってください」に絞ったもの。
 * 「と言われた件」「と言うエラー」の引用は頼みではないので採らない）。
 * 引用が 2 つ以上あれば最後のもの（頼みは最後の段落に多い）。案の長さを超えるもの・無ければ空（呼び出し側は今までどおり口で作る）
 */
export function quotedNextAsk(text: string): string {
  const quoted = quotedAsks((text ?? '').normalize('NFC')).at(-1) ?? ''
  return quoted && [...quoted].length <= NEXT_ASK_MAX_CHARS ? quoted : ''
}

export interface ComposedNextAsk {
  /** 出す案。空なら出さない */
  next_ask: string
  /** 1 回目の案に見つかった点（あれば作り直している） */
  first: NextAskIssueCode[]
  /**
   * 作り直しても駄目で、案を出さなかった理由。出したとき・1 回目が空だった（作れなかっただけ）ときは空。
   * 作り直しが空・口の失敗で終わったときは、1 回目の理由をそのまま入れる（「作り直して出した」と取り違えない）
   */
  dropped: NextAskIssueCode[]
}

export interface ComposeOptions {
  /** プロンプトの作り方（比べる道具が別のプロンプトを渡す。既定は `nextAskPrompt()`） */
  prompt?: (userText: string, text: string, opts?: { retry?: NextAskRetry }) => string
  /** 確かめるか（比べる道具が「確かめなし」を測るときだけ false） */
  check?: boolean
  /**
   * 作り直す直前に聞く。false なら口を叩かず、案なしで終わる（作っている間に画面から切られた・次のターンが来た。
   * 1 回目の前の確かめだけだと、作り直しのぶんが素通りする。#736 のレビュー）
   */
  stillWanted?: () => boolean
}

/**
 * 口で案を 1 つ作る（#729）。出来上がりを `nextAskIssues()` で確かめ、人の返信として読めなければ **1 回だけ** 作り直す。
 * それでも駄目なら**出さない**（間違った案が入力欄に入るより、無いほうがよい）。`summarize` は口を 1 回呼ぶ。
 * 1 回目の失敗はそのまま投げる（呼ぶ側が口の失敗として数える）。**作り直しの失敗は飲み込んで「出さない」にする**
 * （1 回目は返っているので口は生きている。投げると同じ行を 2 呼び出しずつ叩き直す）。
 * 引用の頼み（`quotedNextAsk()`）は呼ぶ側が先に見る（口を呼ばない道なので、ここには入れない）
 */
export async function composeNextAsk(userText: string, text: string, summarize: (prompt: string) => Promise<string>, opts: ComposeOptions = {}): Promise<ComposedNextAsk> {
  const prompt = opts.prompt ?? nextAskPrompt
  const raw = await summarize(prompt(userText, text))
  const made = cleanNextAsk(raw)
  if (opts.check === false) return { next_ask: made, first: [], dropped: [] }
  // 確かめるのは長さで切る前の文（切ると文末の形が消える）
  const first = nextAskIssues(tidyNextAsk(raw), text)
  if (first.length === 0) return { next_ask: made, first: [], dropped: [] }
  const codes = first.map((i) => i.code)
  if (opts.stillWanted && !opts.stillWanted()) return { next_ask: '', first: codes, dropped: [] }
  let rawAgain: string
  try {
    rawAgain = await summarize(prompt(userText, text, { retry: { nextAsk: made, issues: first } }))
  } catch {
    return { next_ask: '', first: codes, dropped: codes }
  }
  const again = cleanNextAsk(rawAgain)
  if (!again) return { next_ask: '', first: codes, dropped: codes }
  const left = nextAskIssues(tidyNextAsk(rawAgain), text)
  return left.length === 0 ? { next_ask: again, first: codes, dropped: [] } : { next_ask: '', first: codes, dropped: left.map((i) => i.code) }
}
