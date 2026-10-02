// 一言（digest）にしないほうがよい返答かを、一言を作っている手元のモデルに聞く（#639）。
// 決め打ちの規則（`needsFullText()`。#638）が当てなかった返答のうち、「案を比べている」「考えの途中を述べている」など
// 決まった言い回しの無いものを拾う。ここはプロンプトと答えの読み方だけを持ち、口は `server/digest/digest.ts` の
// `Summarizer` をそのまま使う。DOM も node も触らないので `shared/fullTextJudge.test.ts` を node:test で回す。

/** 本文がこれより長ければ、頭と末尾だけを渡す（問いかけや「残っていること」は末尾に来る） */
export const FULL_TEXT_JUDGE_HEAD = 1800
export const FULL_TEXT_JUDGE_TAIL = 1200

/** 判定に渡す本文。長ければ頭と末尾（真ん中は落とす） */
export function judgeBody(text: string): string {
  const t = text ?? ''
  if (t.length <= FULL_TEXT_JUDGE_HEAD + FULL_TEXT_JUDGE_TAIL) return t
  return `${t.slice(0, FULL_TEXT_JUDGE_HEAD)}\n…（中略）…\n${t.slice(-FULL_TEXT_JUDGE_TAIL)}`
}

/**
 * LLM に渡すプロンプト。**本文を先、問いを後**に置く（小さいモデルは、問いが先だと長い本文のあとで忘れる。
 * 手元の記録で比べた結果は docs/history/digest.md）。作例・具体的な番号・中身の語は置かない（`persona.test.ts` と同じ決まり）
 */
export function fullTextJudgePrompt(text: string): string {
  return [
    '<返答>',
    judgeBody(text),
    '</返答>',
    '',
    '上はコーディングエージェントが人に返した返答です。',
    '',
    'この返答は「終わった作業の報告」ですか、それとも「人の判断を待っている途中の話（案の比較・提案・相談・未解決の問題の説明）」ですか。',
    '報告なら SUMMARY、判断待ちなら FULL と、1 語だけで答えてください。迷ったら SUMMARY です。',
  ].join('\n')
}

/**
 * 答えを読む。`true` = 全文が要る（一言にしない）、`false` = 要約で足りる、`null` = 読めない（1 語でない・空・両方書いてある）。
 * **読めないときは呼び出し側が今までどおり一言を作る**（狭い方に倒す）
 */
export function parseFullTextJudge(answer: string): boolean | null {
  const t = (answer ?? '').trim().replace(/^[「『"'`*\s]+|[」』"'`*\s。.]+$/g, '').toUpperCase()
  if (t === 'FULL') return true
  if (t === 'SUMMARY') return false
  return null
}
