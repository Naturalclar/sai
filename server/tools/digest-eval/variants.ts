// 比べる案の一覧（#712）。**最初に書いた案が「今のプロンプト」で、ほかはそれと比べる**。
//
// 案は「本文と頼んだことを受けて、一言を返す関数」。口を何回呼ぶか・呼ばないかは案が決める
// （2 つの欄に分けて答えさせて繋ぐ・LLM を呼ばずに本文から抜き出す、もこの形で書ける）。
// 新しい案はここに足して `pnpm digest:eval --variants current,<id>` で比べる。
// プロンプトの決まり（作例に具体的な番号・中身の語を置かない。`shared/persona.test.ts`）は、ここに書く案にも当てはまる
import { firstLine, requestSentence } from '../../../shared/digestCheck.ts'
import { cleanWhat, digestPlan, joinDigest } from '../../../shared/digestParts.ts'
import { DIGEST_MAX_CHARS, digestPrompt, digestWhatPrompt, personaOf } from '../../../shared/persona.ts'
import type { PersonaId } from '../../../shared/types.ts'

export interface VariantInput {
  persona: PersonaId
  /** エージェントの返答 */
  text: string
  /** 人が頼んだこと */
  ask: string
}

export interface Variant {
  id: string
  /** 何の案か（結果の見出しに出す） */
  label: string
  /** 一言を作る。`summarize` は口を 1 回呼ぶ（呼ばなくてもよい） */
  make(input: VariantInput, summarize: (prompt: string) => Promise<string>): Promise<string>
}

export const VARIANTS: readonly Variant[] = [
  {
    id: 'current',
    label: '今のプロンプト（`digestPrompt()`。作り直しはしない 1 回目の一言）',
    make: (input, summarize) => summarize(digestPrompt(input.persona, input.text, { ask: input.ask })),
  },
  {
    // 物差し。規則を 1 つも足さないとどうなるか（足してきた規則が何を防いでいるかを、同じ事例で見る）
    id: 'bare',
    label: '規則なし（長さと口調だけを言う。物差し）',
    make: (input, summarize) =>
      summarize(
        [
          '以下はコーディングエージェントがユーザーに返した文です。これを、チャットの一言コメントに言い換えてください。',
          `- 日本語で 1〜2 文、${DIGEST_MAX_CHARS} 文字以内`,
          '- 出力は一言だけ。引用符、前置き、説明は付けない',
          `- 口調: ${personaOf(input.persona).tone}`,
          '',
          '---',
          input.text,
        ].join('\n'),
      ),
  },
  {
    // #713 で比べて選んだ形: 「人が次にすること」は本文の文そのまま、口には「何が起きたか」だけを書かせる
    id: 'two-part',
    label: '2 つで組む（何が起きたかだけを書かせ、人が次にすることは本文の文をそのまま足す。抜ける文が無ければ今のプロンプト）',
    make: async (input, summarize) => {
      const plan = digestPlan(input.text)
      if (plan.kind === 'full') return summarize(digestPrompt(input.persona, input.text, { ask: input.ask }))
      const what = cleanWhat(plan, await summarize(digestWhatPrompt(input.persona, input.text, { ask: input.ask })))
      return joinDigest(what, plan.kind === 'two' ? plan.next : '')
    },
  },
  {
    // 物差し（#713）: LLM を呼ばない。本文の 1 行目 + 頼みの文。1 行目が使えなければ今のプロンプトに落とす。口調は付かない
    id: 'extract',
    label: '要約せずに抜き出す（本文の 1 行目 + 頼みの文。使えなければ今のプロンプト。口調なしの物差し）',
    make: async (input, summarize) => {
      const head = firstLine(input.text)
      if (!head) return summarize(digestPrompt(input.persona, input.text, { ask: input.ask }))
      const next = requestSentence(input.text)
      return joinDigest(head, next === head ? '' : next)
    },
  },
]

/** `current,bare` → 案の並び。知らない ID・重なりがあれば文で返す */
export function pickVariants(spec: string, all: readonly Variant[] = VARIANTS): Variant[] | string {
  const ids = spec.split(',').map((s) => s.trim()).filter(Boolean)
  if (ids.length === 0) return '案を 1 つは指定してください'
  if (new Set(ids).size !== ids.length) return '同じ案を 2 回指定しています'
  const out: Variant[] = []
  for (const id of ids) {
    const v = all.find((x) => x.id === id)
    if (!v) return `知らない案: ${id}（あるのは ${all.map((x) => x.id).join(', ')}）`
    out.push(v)
  }
  return out
}
