// 一言（digest）と同じ口・同じタイミングで作る「次に送る文面の案」（#371）。
// エージェント自身が出す入力の候補は SAI に届かない: Claude は候補そのものが transcript にもフックの payload にも
// 書かれず（人が選んだ後に `promptSource: "suggestion_accepted"` が付くだけ）、Codex は提案を作る裏の LLM 呼び出しを
// `record.py` の `is_codex_internal_turn()` が捨てている（セッション ID が無く、同じ cwd の無関係なセッションに紛れ込むため）。
// ここはプロンプトと後始末だけを持ち、口は `server/digest/digest.ts` の `Summarizer` をそのまま使う。
// DOM も node も触らないので `shared/nextAsk.test.ts` を node:test で回す。

/**
 * 案の長さの目安（文字）。プロンプトで指示し、超えたぶんは `cleanNextAsk()` が切る。
 * 入力欄の上のチップに 1 行で出すので、一言（`DIGEST_MAX_CHARS` = 80）より短くする
 */
export const NEXT_ASK_MAX_CHARS = 60

/**
 * LLM に渡すプロンプト。一言と違って性格（口調）は足さない。
 * **これは人が送る文**で、エージェントの声ではないため（性格を混ぜると、自分が打った覚えのない口調の文が入力欄に入る）
 */
export function nextAskPrompt(userText: string, text: string): string {
  const asked = (userText ?? '').trim()
  return [
    'あなたはコーディングエージェントを使っている人です。直前のやりとりを読んで、**あなたが次に送る文**を 1 つ考えてください。',
    `- 日本語で 1 文、${NEXT_ASK_MAX_CHARS} 文字以内。エージェントへの指示か質問にする`,
    // 一言と同じ理由（#268）。本文に無い番号を書かせない。**作例に具体的な数字や題材を置かない**のも同じ
    // （小さいモデルは作例をそのまま書き写すので、番号の無いターンでもその数字を書いてしまう）
    '- **本文に書かれていることだけ**を材料にする。番号（`#` に続く数字）・ファイル名・コマンドは本文にあるものだけ使い、本文に無い番号は書かない',
    '- **本文にエージェントからの質問や頼みがあれば、それに答える文にする**（最優先。選択肢が示されていればどれかを選ぶ）',
    '- 本文が報告だけで終わっているなら、そこから自然に続く一手にする。本文に出てこない作業を思いつきで足さない',
    '- 出力は文だけ。引用符、「案:」などの前置き、箇条書きの印、2 つ目以降の案は付けない',
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
  return body.length > NEXT_ASK_MAX_CHARS ? body.slice(0, NEXT_ASK_MAX_CHARS) : body
}
