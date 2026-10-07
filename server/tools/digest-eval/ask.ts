// 「次に送る文面の案」（next_ask）の作り方を、決まった事例で比べる（#729）。`pnpm digest:eval --ask`。**手元で回すもの**。
//
// 見るのは 2 つの割合: **人の返信として読める**（案が出て、`nextAskIssues()` に何も引っかからない）と、**案を出さなかった**。
// 採点は本番の確かめと同じ `shared/nextAskCheck.ts`（LLM の採点役は使わない）。なので「確かめあり」の案は、出たものは必ず読める側に入る。
// 確かめの効き目は「読める割合がどれだけ増え、出ない割合がどれだけ増えたか」で読む。
// 事例の置き場は隣の `ask-cases.json`（**作り物だけ**）。形は本文の終わり方で分ける。
import { NEXT_ASK_MAX_CHARS, composeNextAsk, quotedNextAsk } from '../../../shared/nextAsk.ts'
import type { NextAskRetry } from '../../../shared/nextAsk.ts'
import { NEXT_ASK_ISSUE_LABELS, nextAskIssues } from '../../../shared/nextAskCheck.ts'
import type { NextAskIssueCode } from '../../../shared/nextAskCheck.ts'
import { caseLeaks } from './score.ts'

/** 事例の形（本文がどう終わるか）。小さいモデルは最後の文の声を写すので、終わり方ごとに数を揃える */
export const ASK_SHAPES = ['question', 'declaration', 'request', 'report', 'choices'] as const
export type AskShape = (typeof ASK_SHAPES)[number]

export const ASK_SHAPE_LABELS: Record<AskShape, string> = {
  question: '問いで終わる',
  declaration: '宣言で終わる',
  request: '人への頼みで終わる',
  report: '報告だけ',
  choices: '選択肢つき',
}

export interface AskCase {
  id: string
  /** 記録から読んだ事例（`--feed`）は形を見分けていないので `feed` */
  shape: AskShape | 'feed'
  /** 人が直前に送った文（行の `user_text` に当たる） */
  ask: string
  /** エージェントの返答（行の `text` に当たる） */
  text: string
}

/** 事例のファイルの形を検査する。問題があれば文を並べて返す（空なら良い） */
export function validateAskCases(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['事例は配列で書く']
  const errors: string[] = []
  const ids = new Set<string>()
  raw.forEach((item: unknown, i) => {
    const c = (item ?? {}) as Record<string, unknown>
    const at = typeof c.id === 'string' && c.id ? c.id : `#${i}`
    const bad = (message: string) => errors.push(`${at}: ${message}`)
    if (typeof c.id !== 'string' || !/^[a-z0-9-]+$/.test(c.id)) bad('id は英小文字・数字・- で書く')
    else if (ids.has(c.id)) bad('id が重なっている')
    else ids.add(c.id)
    if (!ASK_SHAPES.includes(c.shape as AskShape)) bad(`shape は ${ASK_SHAPES.join(' / ')} のどれか`)
    if (typeof c.ask !== 'string') bad('ask は文字（無ければ空）')
    if (typeof c.text !== 'string' || !c.text.trim()) return bad('text が空')
    // 引用の頼みがある本文は口を呼ばずに引用を採る（#718）ので、口の比べには使えない
    if (quotedNextAsk(c.text)) bad('本文に引用の頼み（「〜」と言ってください）がある（機械で採る道に入り、口を呼ばない）')
    for (const leak of caseLeaks(`${c.text}\n${typeof c.ask === 'string' ? c.ask : ''}`)) bad(leak)
  })
  return errors
}

/**
 * 文末の形で縛ったプロンプト（#729 の案 3）。**本番には入れていない**: 確かめなしでは読める割合が上がるが、
 * 確かめと合わせると今のプロンプトより良くならず、選択肢つきの本文では下がった。比べる相手として残す
 */
export function formNextAskPrompt(userText: string, text: string, opts: { retry?: NextAskRetry } = {}): string {
  const asked = (userText ?? '').trim()
  const { retry } = opts
  const fix = retry ? ['', `前に作った文: ${retry.nextAsk}`, 'この文には次の点がありました。直して作り直してください:', ...retry.issues.map((i) => `- ${i.hint}`)] : []
  return [
    'あなたはコーディングエージェントを使っている人です。直前のやりとりを読んで、**あなたが次に送る文**（エージェントへの返信）を 1 つ考えてください。',
    `- 日本語で 1 文、${NEXT_ASK_MAX_CHARS} 文字以内。**エージェントへの指示（「〜して」の形）か、エージェントの問いへの答え**にする`,
    '- **エージェントの文を写さない。** 「〜します」「〜しました」（エージェントが言う宣言）、「〜しますか？」「〜しましょうか？」（エージェントが聞く問い）で終わる文は書かない',
    '- 本文がエージェントの問いで終わっているなら、**問いを繰り返さず、答えを書く**（進めてよければ、その作業を「〜して」と指示する。選択肢が示されていればどれかを選ぶ）',
    '- 本文がエージェントからあなたへの頼み（「〜してください」）で終わっているなら、同じ頼みをエージェントに返さない',
    // 一言と同じ理由（#268）。本文に無い番号を書かせない。**作例に具体的な数字や題材を置かない**のも同じ
    // （小さいモデルは作例をそのまま書き写すので、番号の無いターンでもその数字を書いてしまう）
    '- **本文に書かれていることだけ**を材料にする。番号（`#` に続く数字）・ファイル名・コマンドは本文にあるものだけ使い、本文に無い番号は書かない',
    '- 本文が報告だけで終わっているなら、そこから自然に続く一手を指示する。本文に出てこない作業を思いつきで足さない',
    '- 出力は文だけ。引用符、「案:」などの前置き、箇条書きの印、2 つ目以降の案は付けない',
    ...fix,
    '',
    '---',
    ...(asked ? ['直前にあなたが送った文:', asked, ''] : []),
    'エージェントの返答:',
    text,
  ].join('\n')
}

export interface AskVariant {
  id: string
  label: string
  /** 案を作る。空なら「出さない」 */
  make(c: AskCase, summarize: (prompt: string) => Promise<string>): Promise<string>
}

export const ASK_VARIANTS: readonly AskVariant[] = [
  { id: 'nocheck', label: '今のプロンプト・確かめなし（#729 の前）', make: async (c, s) => (await composeNextAsk(c.ask, c.text, s, { check: false })).next_ask },
  { id: 'check', label: '今のプロンプト・確かめあり（駄目なら 1 回作り直し、それでも駄目なら出さない。いまの本番）', make: async (c, s) => (await composeNextAsk(c.ask, c.text, s)).next_ask },
  { id: 'form', label: '形で縛ったプロンプト・確かめなし（入れていない）', make: async (c, s) => (await composeNextAsk(c.ask, c.text, s, { prompt: formNextAskPrompt, check: false })).next_ask },
  { id: 'form-check', label: '形で縛ったプロンプト・確かめあり（入れていない）', make: async (c, s) => (await composeNextAsk(c.ask, c.text, s, { prompt: formNextAskPrompt })).next_ask },
]

/** `nocheck,check` → 案の並び。知らない ID・重なりがあれば文で返す */
export function pickAskVariants(spec: string): AskVariant[] | string {
  const ids = spec.split(',').map((s) => s.trim()).filter(Boolean)
  if (ids.length === 0) return '案を 1 つは指定してください'
  if (new Set(ids).size !== ids.length) return '同じ案を 2 回指定しています'
  const out: AskVariant[] = []
  for (const id of ids) {
    const v = ASK_VARIANTS.find((x) => x.id === id)
    if (!v) return `知らない案: ${id}（--ask であるのは ${ASK_VARIANTS.map((x) => x.id).join(', ')}）`
    out.push(v)
  }
  return out
}

/** 1 回の出力（事例 × 案 × 回）。`error` があれば口が落ちた回 */
export interface AskSample {
  case: string
  shape: string
  variant: string
  run: number
  /** 出した案。空なら出さなかった */
  next_ask: string
  /** 出した案に見つかった点（`nextAskIssues()`）。空なら人の返信として読める */
  codes: NextAskIssueCode[]
  error?: string
}

/** 事例 × 回 × 案を順に回す（同じ事例・同じ回を、案を続けて回す）。口が落ちた回は `error` として残し、止めない */
export async function runAsk(opts: {
  cases: readonly AskCase[]
  variants: readonly AskVariant[]
  runs: number
  summarize: (prompt: string) => Promise<string>
  progress?: (line: string) => void
}): Promise<AskSample[]> {
  const samples: AskSample[] = []
  const total = opts.cases.length * opts.runs * opts.variants.length
  for (const c of opts.cases) {
    for (let turn = 1; turn <= opts.runs; turn++) {
      for (const v of opts.variants) {
        const base = { case: c.id, shape: c.shape, variant: v.id, run: turn }
        try {
          const nextAsk = await v.make(c, opts.summarize)
          samples.push({ ...base, next_ask: nextAsk, codes: nextAskIssues(nextAsk, c.text).map((i) => i.code) })
        } catch (err) {
          samples.push({ ...base, next_ask: '', codes: [], error: err instanceof Error ? err.message : String(err) })
        }
        opts.progress?.(`[${samples.length}/${total}] ${c.id} ${v.id}${samples[samples.length - 1]!.error ? ' 口の失敗' : ''}`)
      }
    }
  }
  return samples
}

export interface AskTotals {
  variant: string
  /** 口が落ちなかった数 */
  samples: number
  errors: number
  /** 人の返信として読める（案が出て、何も引っかからない） */
  readable: number
  /** 案を出さなかった */
  none: number
  /** 出したが、人の返信として読めない（理由ごと） */
  codes: Partial<Record<NextAskIssueCode, number>>
}

export function askTotals(variant: string, samples: readonly AskSample[]): AskTotals {
  const own = samples.filter((s) => s.variant === variant)
  const ok = own.filter((s) => !s.error)
  const codes: Partial<Record<NextAskIssueCode, number>> = {}
  for (const s of ok) for (const c of new Set(s.codes)) codes[c] = (codes[c] ?? 0) + 1
  return { variant, samples: ok.length, errors: own.length - ok.length, readable: ok.filter((s) => s.next_ask && s.codes.length === 0).length, none: ok.filter((s) => !s.next_ask).length, codes }
}

const rate = (n: number, of: number): string => (of > 0 ? `${n}（${Math.round((n / of) * 100)}%）` : String(n))
const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`

/** 結果（Markdown）。数字だけで、本文と案は入らない */
export function askReport(samples: readonly AskSample[], variants: readonly string[], notes: readonly string[] = []): string[] {
  const totals = variants.map((v) => askTotals(v, samples))
  const head = ['項目', ...variants]
  const lines = ['## 次に送る文面の案の比べ', '', ...notes.map((n) => `- ${n}`), '', row(head), row(head.map(() => '---'))]
  lines.push(row(['口が返した', ...totals.map((t) => String(t.samples))]))
  lines.push(row(['口の失敗', ...totals.map((t) => String(t.errors))]))
  lines.push(row(['**人の返信として読める**', ...totals.map((t) => rate(t.readable, t.samples))]))
  lines.push(row(['**案を出さなかった**', ...totals.map((t) => rate(t.none, t.samples))]))
  for (const code of Object.keys(NEXT_ASK_ISSUE_LABELS) as NextAskIssueCode[]) {
    if (totals.every((t) => !t.codes[code])) continue
    lines.push(row([`${NEXT_ASK_ISSUE_LABELS[code]} \`${code}\``, ...totals.map((t) => rate(t.codes[code] ?? 0, t.samples))]))
  }
  // 形ごとの「読める」。どの終わり方で崩れるかを見る
  const shapes = [...new Set(samples.map((s) => s.shape))]
  if (shapes.length > 1) {
    const shapeHead = ['形ごとの「読める」', ...variants]
    lines.push('', row(shapeHead), row(shapeHead.map(() => '---')))
    for (const shape of shapes) {
      const of = (v: string) => askTotals(v, samples.filter((s) => s.shape === shape))
      lines.push(row([ASK_SHAPE_LABELS[shape as AskShape] ?? shape, ...variants.map((v) => rate(of(v).readable, of(v).samples))]))
    }
  }
  return lines
}
