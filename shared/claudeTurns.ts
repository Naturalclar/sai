// Claude の transcript をターンに切って、そのターンの返答を取る（#614）。
// ターン完了（Stop）の行が落ちた・本文が空だったときに、SAI が返答を**記録の外から補う**ための読み方。
// 何を「そのターンの返答」とするかは `feed/record.py` の `_turn_assistant_text()` と同じ:
// 人の入力の行で区切り、そのターンの**いちばん新しい本文のある assistant の行**を取り、その行が閉じた行
// （`end_turn` / `stop_sequence`）のときだけ「閉じた」とする。前のターンには遡らない（#467）
type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export interface ClaudeTurn {
  /** 人の入力の行の時刻（ミリ秒）。読めなければ NaN */
  startedAt: number
  /** 人の入力の本文（突き合わせ用。頭だけ使う） */
  input: string
  /** そのターンのいちばん新しい返答の本文。無ければ空 */
  text: string
  /** その本文の行が閉じた行か（閉じていなければ、回っている・Esc で止めた・途中で落ちた） */
  closed: boolean
  /** その本文の行の時刻（ISO）。無ければ空 */
  endedAt: string
  /** このあとに人の入力が続いている（= このターンはもう変わらない） */
  over: boolean
  /**
   * その本文は返答ではなく、**ログイン切れで CLI が出した文**（行の `error: "authentication_failed"`。#577。
   * `Not logged in · Please run /login`）。ターンは途中で止まっている。違えば無い
   */
  authFailed?: true
}

const CLOSED = new Set(['end_turn', 'stop_sequence'])

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(obj)
    .filter((b) => b?.type === 'text')
    .map((b) => str(b?.text))
    .join('\n')
}

/**
 * その行を JSON として読む値打ちがあるか（頭から全部読むときの下ごしらえ。#614）。
 * transcript の大半はツールの戻りとツール呼び出しで（1 行に画像が丸ごと入ることもある）、どれも入力にも返答にもならない。
 * **落とすのは確実に要らない行だけ**（迷ったら読む）: ツールの戻りの行と、本文（text）の無い assistant の行
 */
export function worthParsing(line: string): boolean {
  if (line.includes('"type":"tool_result"')) return false
  if (line.includes('"type":"assistant"') && !line.includes('"type":"text"')) return false
  return true
}

/**
 * 行を 1 つずつ受けてターンに切る（大きい transcript を溜めずに読むため）。`push()` した順に `turns` に溜まる。
 * 読み始めがターンの途中なら、その途中のぶん（入力の行より前の assistant の行）は捨てる
 */
export function turnParser(): { push: (line: string) => void; turns: ClaudeTurn[] } {
  const turns: ClaudeTurn[] = []
  let cur: ClaudeTurn | null = null
  const push = (line: string) => {
    if (!line || line[0] !== '{') return
    let o: Obj | null
    try {
      o = obj(JSON.parse(line))
    } catch {
      return
    }
    if (!o || o.isSidechain === true || o.isMeta === true) return
    const message = obj(o.message)
    if (o.type === 'user') {
      if (o.isCompactSummary === true) return
      const content = message?.content
      const blocks = Array.isArray(content) ? content.map(obj) : []
      // ツールの戻りだけの行は入力ではない
      if (blocks.some((b) => b?.type === 'tool_result')) return
      const input = blocksText(content).trim()
      if (!input) return
      if (cur) cur.over = true
      cur = { startedAt: Date.parse(str(o.timestamp)), input, text: '', closed: false, endedAt: '', over: false }
      turns.push(cur)
      return
    }
    if (o.type !== 'assistant' || !cur || !message) return
    const text = blocksText(message.content).trim()
    if (!text) return
    // いちばん新しい本文が勝つ
    cur.text = text
    if (o.error === 'authentication_failed') cur.authFailed = true
    else delete cur.authFailed
    cur.closed = CLOSED.has(str(message.stop_reason))
    cur.endedAt = str(o.timestamp)
  }
  return { push, turns }
}

/** 行（古い順）をターンに切る */
export function claudeTurns(lines: Iterable<string>): ClaudeTurn[] {
  const parser = turnParser()
  for (const line of lines) parser.push(line)
  return parser.turns
}

/** 突き合わせの許す幅。入力の行（フック）と transcript の入力の行は同じ瞬間に書かれるが、行の ts は秒まで */
export const TURN_START_SLACK_MS = 10_000
/** 本文が空のターン完了の行（#613）は、ターンが閉じてから `record.py` の締切（15 秒）までに書かれる */
export const TURN_END_BEFORE_MS = 60_000
export const TURN_END_AFTER_MS = 5_000

const head = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 40)

/**
 * 記録の行に当たるターンを探す。
 * - `startMs`（入力の行の時刻）があれば、始まりがそれに近いターン。複数あれば入力の頭が同じもの、無ければ一番近いもの
 * - 無ければ `endMs`（本文が空のターン完了の行の時刻）の少し前に終わったターンのうち、一番新しいもの
 *
 * 見つからなければ null（**近いだけの別のターンは返さない**。前のターンの返答を出すより、出さない方がよい）
 */
export function findTurn(turns: readonly ClaudeTurn[], at: { startMs?: number; endMs?: number; input?: string }): ClaudeTurn | null {
  if (at.startMs !== undefined && Number.isFinite(at.startMs)) {
    const near = turns.filter((t) => Math.abs(t.startedAt - at.startMs!) <= TURN_START_SLACK_MS)
    if (near.length === 0) return null
    const want = at.input ? head(at.input) : ''
    const same = want ? near.filter((t) => head(t.input) === want) : []
    const pool = same.length > 0 ? same : near
    return pool.reduce((a, b) => (Math.abs(b.startedAt - at.startMs!) < Math.abs(a.startedAt - at.startMs!) ? b : a))
  }
  if (at.endMs !== undefined && Number.isFinite(at.endMs)) {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]!
      const ended = Date.parse(t.endedAt)
      if (Number.isFinite(ended) && ended >= at.endMs - TURN_END_BEFORE_MS && ended <= at.endMs + TURN_END_AFTER_MS) return t
    }
  }
  return null
}
