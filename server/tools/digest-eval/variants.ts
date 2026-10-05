// 比べる案の一覧（#712）。**最初に書いた案が「今のプロンプト」で、ほかはそれと比べる**。
//
// 案は「本文と頼んだことを受けて、一言を返す関数」。口を何回呼ぶか・呼ばないかは案が決める
// （2 つの欄に分けて答えさせて繋ぐ・LLM を呼ばずに本文から抜き出す、もこの形で書ける）。
// 新しい案はここに足して `pnpm digest:eval --variants current,<id>` で比べる。
// プロンプトの決まり（作例に具体的な番号・中身の語を置かない。`shared/persona.test.ts`）は、ここに書く案にも当てはまる
import { DIGEST_MAX_CHARS, digestPrompt, personaOf } from '../../../shared/persona.ts'
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
