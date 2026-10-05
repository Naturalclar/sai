// 一言（digest）を「何が起きたか」と「人が次にすること」の 2 つで組む（#713）。LLM は呼ばない純粋関数だけを置く
// （口を呼ぶのは server/digest/digest.ts と、案を比べる server/tools/digest-eval/）。shared/digestParts.test.ts で回す。
//
// 比べた結果（#713 のコメント。作り物 28 件 × 2 回、qwen3:8b）: 2 つの欄を 1 回で答えさせる形は、頼みを作る回が増えた。
// 「人が次にすること」を本文の文そのままにし、言い換えさせるのを「何が起きたか」だけにした形が、性格を残す案の中で一番引っかからなかった
import { mentionsNext, requestSentence, stripAsks } from './digestCheck.ts'

/**
 * 一言の作り方。
 * - `two`: 本文に人への頼みの文がある。その文を**本文の言葉のまま**「人が次にすること」にし、口には「何が起きたか」だけを書かせる
 * - `report`: 本文は報告だけ（人がすることに触れていない）。「何が起きたか」だけを書かせる（頼みを作らせない）
 * - `full`: 人がすることに触れているが、そのまま抜ける文が無い（頼みの形でない言い方・質問）。日本語でない本文もここ。
 *   今までどおり 1 回で全部を書かせる（`digestPrompt()`）
 */
export type DigestPlan = { kind: 'two'; next: string } | { kind: 'report' } | { kind: 'full' }

export function digestPlan(text: string): DigestPlan {
  const next = requestSentence(text)
  if (next) return { kind: 'two', next }
  // 頼みを見つける規則は日本語の言い回しだけを見ている。日本語でない本文は「報告だけ」と決めつけない
  // （英語の本文の頼みを「人への頼みは書かない」で落としてしまう。比べたときに実際に落ちた）
  return mentionsNext(text) || !mostlyJapanese(text) ? { kind: 'full' } : { kind: 'report' }
}

/** 本文の文字（記号・空白・コードを除く）のうち、かな・漢字が 3 割以上か */
function mostlyJapanese(text: string): boolean {
  const letters = text.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/`[^`\n]*`/g, '').match(/[\p{L}]/gu) ?? []
  if (letters.length === 0) return true
  const japanese = letters.filter((c) => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(c)).length
  return japanese / letters.length >= 0.3
}

/**
 * 口が返した「何が起きたか」を整える。`two` の回は、言い換えた頼みが混ざっていれば落とす
 * （本文の言葉のままの頼みを後ろに足すので、2 つ並ぶ・片方が問いかけに化けるのを防ぐ）
 */
export function cleanWhat(plan: DigestPlan, what: string): string {
  return plan.kind === 'two' ? stripAsks(what.trim()) : what.trim()
}

/** 2 つを続けて読める 1 つの文にする（画面に見出しは出さない）。「人が次にすること」が無ければ「何が起きたか」だけ */
export function joinDigest(what: string, next: string): string {
  if (!next) return what
  if (!what) return next
  // 記号・絵文字で終わっていれば句点を足さない（口調によっては絵文字で終える）
  return `${/[\p{P}\p{S}\p{Extended_Pictographic}\uFE0F]$/u.test(what) ? what : `${what}。`}${next}`
}
