// 一言（digest）のプロンプトを比べるための、事例の形と採点（#712）。**LLM は呼ばない純粋関数**。
//
// 採点は 2 つを足したもの: どの本文にも当てる `digestIssues()`（shared/digestCheck.ts）と、事例ごとに書いた「守ること」。
// 判定は新しく作らず、頼みの有無は `digestCheck.ts` の `asksPerson()` / `hasNextAction()` をそのまま呼ぶ。
// 事例の置き場は隣の `cases.json`（**作り物だけ**。実際の返答はコミットしない）。回す道具は `cli.ts`。
import { asksPerson, digestIssues, hasNextAction } from '../../../shared/digestCheck.ts'
import type { DigestIssueCode } from '../../../shared/digestCheck.ts'

/** 事例の形（返答がどう終わるか・何が入っているか）。偏らないように、形ごとに数を揃える */
export const SHAPES = ['done', 'merge_wait', 'question', 'failure', 'multi_number', 'no_number', 'english', 'long'] as const
export type Shape = (typeof SHAPES)[number]

export const SHAPE_LABELS: Record<Shape, string> = {
  done: '完了の報告',
  merge_wait: '「マージして」待ち',
  question: '質問で終わる',
  failure: '失敗の報告',
  multi_number: '番号が複数',
  no_number: '番号なし',
  english: '英語の本文',
  long: '長い本文',
}

/**
 * 事例ごとの「守ること」。どれも一言の文字だけで見られる形にする（意味の良し悪しは見ない）。
 * 書いていない項目は見ない
 */
export interface Expect {
  /** 一言にそのまま残る文字（人に言ってほしい言葉の引用など）。全部が要る */
  keep?: string[]
  /** 一言に出る番号（`#` 抜きの数字）。全部が要る */
  numbers?: string[]
  /** 一言に出てはいけない番号（本文にはあるが、主な話ではない・別の話の番号） */
  no_numbers?: string[]
  /** 動作の語。どれか 1 つが出る（`マージ`） */
  action?: string[]
  /** 出てはいけない動作の語（本文は「作成」なのに `マージ` と書く、など） */
  no_action?: string[]
  /** `keep` = 人が次にすることが一言に残る。`none` = 一言が頼み・問いかけを作らない */
  request?: 'keep' | 'none'
}

export interface EvalCase {
  id: string
  /** 記録から読んだ事例（`--feed`）は形を見分けていないので `feed` */
  shape: Shape | 'feed'
  /** 人がそのターンで頼んだこと（行の `user_text` に当たる） */
  ask: string
  /** エージェントの返答（行の `text` に当たる） */
  text: string
  /** 記録から読んだ事例（`--feed`）には無い。そのときは `digestIssues()` だけで採点する */
  expect?: Expect
}

/** 事例の「守ること」に反したときの項目。`digestIssues()` の項目と混ざらないよう `expect:` を付ける */
export type ExpectCode = 'expect:keep' | 'expect:number_missing' | 'expect:number_extra' | 'expect:action_missing' | 'expect:action_wrong' | 'expect:request_dropped' | 'expect:request_invented'

export type ScoreCode = DigestIssueCode | ExpectCode

export const SCORE_LABELS: Record<ScoreCode, string> = {
  invented_number: '本文に無い番号',
  'expect:number_extra': '出してはいけない番号（事例）',
  dropped_request: '頼みが落ちた',
  'expect:request_dropped': '頼みが落ちた（事例）',
  'expect:keep': '残す文字が無い（事例）',
  action_swap: '動作の取り違え',
  'expect:action_wrong': '違う動作の語（事例）',
  kind_swap: '種類の取り違え（PR / Issue）',
  quoted_request: '引用の頼みが問いかけに化けた',
  invented_request: '頼みを作った',
  'expect:request_invented': '頼みを作った（事例）',
  waiting_without_next: '待ちで終わる',
  bare_number: '番号だけ（題名なし）',
  'expect:number_missing': '出るはずの番号が無い（事例）',
  'expect:action_missing': '動作の語が無い（事例）',
  meta_reply: '要約せず答えた',
  prefix: '前置き・引用符',
  too_long: '長さ超過',
  empty: '空',
}

/** 表に出す順（意味が変わるもの → 落ちたもの → 形）。`SCORE_LABELS` の並びがそのまま順になる */
export const SCORE_ORDER = Object.keys(SCORE_LABELS) as ScoreCode[]

/** その番号が一言に出ているか。前後が数字なら別の番号（`#912` の中の `12`） */
function hasNumber(summary: string, n: string): boolean {
  return new RegExp(`(?<!\\d)${n}(?!\\d)`).test(summary)
}

/** 事例の「守ること」に反した項目（出てきた順・同じ項目は 1 つ） */
export function expectIssues(expect: Expect, rawSummary: string): ExpectCode[] {
  const summary = rawSummary.normalize('NFC')
  const out = new Set<ExpectCode>()
  if (expect.keep?.some((s) => !summary.includes(s))) out.add('expect:keep')
  if (expect.numbers?.some((n) => !hasNumber(summary, n))) out.add('expect:number_missing')
  if (expect.no_numbers?.some((n) => hasNumber(summary, n))) out.add('expect:number_extra')
  if (expect.action && expect.action.length > 0 && !expect.action.some((s) => summary.includes(s))) out.add('expect:action_missing')
  if (expect.no_action?.some((s) => summary.includes(s))) out.add('expect:action_wrong')
  if (expect.request === 'keep' && !hasNextAction(summary)) out.add('expect:request_dropped')
  if (expect.request === 'none' && asksPerson(summary)) out.add('expect:request_invented')
  return [...out]
}

/** 一言 1 つの採点。`digestIssues()` の項目と、事例の「守ること」の項目を続けて返す */
export function scoreSummary(c: EvalCase, summary: string): ScoreCode[] {
  const base: ScoreCode[] = digestIssues(c.text, summary, c.ask).map((i) => i.code)
  // 空の一言は `empty` だけ（「残す文字が無い」などを重ねて数えない）
  if (base.includes('empty') || !c.expect) return base
  return [...base, ...expectIssues(c.expect, summary)]
}

/**
 * 事例に置く番号の下限。**実在の issue / PR の番号を書かない**ために、このリポジトリにまだ無い大きさだけを使う
 * （小さいモデルは事例の番号を覚えないが、コミットする文に実在の番号と題名の組が並ぶのを避ける）
 */
export const CASE_NUMBER_MIN = 9000

/** 事例の文に入っていたら落とす形（#712 の歯止め）。呼び名は一覧にできないので、形で見られるものだけ */
const LEAKS: readonly { label: string; re: RegExp }[] = [
  { label: 'ホームのパス', re: /\/(?:Users|home)\/[A-Za-z0-9._-]+/g },
  { label: 'メールアドレスの形', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { label: 'セッション ID（UUID）', re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi },
  { label: 'セッション ID（ses_）', re: /\bses_[A-Za-z0-9]{6,}/g },
  { label: 'アカウント名の URL', re: /github\.com\/[A-Za-z0-9_-]+/gi },
  // 作り物の形（`dev-worktree-a`）だけは通す
  { label: 'worktree 名', re: /(?<![A-Za-z0-9])dev-(?!worktree-[a-z](?![A-Za-z0-9]))[A-Za-z0-9]+/g },
]

/** 文に入っている、コミットしてはいけない形（何が・どの文字か）。無ければ空 */
export function caseLeaks(text: string): string[] {
  const out: string[] = []
  for (const { label, re } of LEAKS) for (const m of text.matchAll(re)) out.push(`${label}: ${m[0]}`)
  for (const m of text.matchAll(/#(\d+)/g)) if (Number(m[1]) < CASE_NUMBER_MIN) out.push(`実在しうる番号（${CASE_NUMBER_MIN} 未満）: ${m[0]}`)
  return out
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s !== '')

const EXPECT_KEYS = ['keep', 'numbers', 'no_numbers', 'action', 'no_action', 'request'] as const

/**
 * 事例のファイルの形を検査する。問題があれば文を並べて返す（空なら良い）。
 * 形だけでなく、**守ることが本文と食い違っていないか**も見る（本文に無い番号を「出る」と書く、など。事例の書き損じを採点の結果と取り違えないため）
 */
export function validateCases(raw: unknown): string[] {
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
    if (!SHAPES.includes(c.shape as Shape)) bad(`shape は ${SHAPES.join(' / ')} のどれか`)
    if (typeof c.ask !== 'string') bad('ask は文字（無ければ空）')
    if (typeof c.text !== 'string' || !c.text.trim()) bad('text が空')
    const e = c.expect
    if (!e || typeof e !== 'object' || Array.isArray(e)) return bad('expect（守ること）が無い')
    const expect = e as Record<string, unknown>
    const keys = Object.keys(expect)
    if (keys.length === 0) bad('expect が空（守ることを 1 つは書く）')
    for (const k of keys) if (!(EXPECT_KEYS as readonly string[]).includes(k)) bad(`expect.${k} は知らない項目`)
    for (const k of ['keep', 'numbers', 'no_numbers', 'action', 'no_action'] as const) {
      if (expect[k] !== undefined && !isStrings(expect[k])) bad(`expect.${k} は空でない文字の配列`)
    }
    if (expect.request !== undefined && expect.request !== 'keep' && expect.request !== 'none') bad('expect.request は keep か none')
    if (typeof c.text !== 'string') return
    const text = c.text
    const source = `${text}\n${typeof c.ask === 'string' ? c.ask : ''}`
    const list = (k: string) => (isStrings(expect[k]) ? expect[k] : [])
    for (const n of [...list('numbers'), ...list('no_numbers')]) {
      if (!/^\d+$/.test(n)) bad(`番号は数字だけで書く（${n}）`)
      else if (!hasNumber(source, n)) bad(`番号 ${n} が本文にも頼んだことにも無い`)
    }
    for (const s of list('keep')) if (!text.includes(s)) bad(`keep の「${s}」が本文に無い（本文の言葉のまま書く）`)
    // 動作の語は言い換え（`作成` / `作り`）も並べてよいが、どれか 1 つは本文の言葉にする
    if (list('action').length > 0 && !list('action').some((s) => text.includes(s))) bad('action のどれも本文に無い（1 つは本文の言葉のまま書く）')
    if (list('numbers').some((n) => list('no_numbers').includes(n))) bad('同じ番号が numbers と no_numbers の両方にある')
    for (const leak of caseLeaks(source)) bad(leak)
  })
  return errors
}
