// `~/.agent-feed` を調べるコマンド（#703）。**読むだけ**で、置き場には何も書かない。読み方は `feedRead.ts`。
//
//   pnpm feed rows <セッション>      あるセッションの最近の行（時刻・種類・入力と返答の頭）
//   pnpm feed messages               送ったメッセージと、返答が届いたか
//   pnpm feed usage                  セッション別・日別の使用量（費用は前の行との差）
//
// 出力は既定で数行の表に絞る（結果は呼んだ側の文脈に残り続けるので）。全部出すのは `--all` を付けたときだけ。
// 置き場は `AGENT_FEED_DIR`（無ければ `~/.agent-feed`）。
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { sessionLabel, splitHandedReplies } from '../../shared/agentMessages.ts'
import { localDate, TIME_ZONE } from '../../shared/entity.ts'
import { eventKind } from '../../shared/events.ts'
import type { FeedRow, SessionSummary } from '../../shared/types.ts'
import {
  dateRange,
  feedDir,
  inRange,
  isDate,
  messageReplies,
  promptKind,
  readAgentMessages,
  readMeta,
  readRows,
  readTurnUsage,
  resolveSession,
  rowEntity,
  sessionsOf,
  usageRows,
  usageTotals,
} from './feedRead.ts'
import type { DateRange, PromptKind } from './feedRead.ts'

export const USAGE = `usage: pnpm feed <rows|messages|usage> [options]   （~/.agent-feed を読むだけ。置き場は AGENT_FEED_DIR）

  rows <セッション>   あるセッションの最近の行。セッションは ID・表示名・worktree 名・ID の頭
  messages            送ったメッセージと返答が届いたか（--session で送り元・宛先を絞る）
  usage               使用量。費用は前の行との差（--by session|day）

  -n <数>             出す行数（既定 10）        --all        全部出す
  --days <数>         読む日数（既定 7）         --from / --to  YYYY-MM-DD（Asia/Tokyo）
  --json              JSON で出す                --full       入力・返答を切らずに出す`

/** 既定で出す行数 */
export const DEFAULT_ROWS = 10
/** 既定で読む日数 */
export const DEFAULT_DAYS = 7
/** 決まらなかったときに並べる候補の数 */
export const CANDIDATES_SHOW = 10

export interface Io {
  dir: string
  now: Date
  out: (line: string) => void
  err: (line: string) => void
}

interface Options {
  n: number
  all: boolean
  json: boolean
  full: boolean
  range: DateRange
  /** 範囲を明示したか（`messages` は明示が無ければ、出すメッセージの日付から決める） */
  ranged: boolean
  by: 'session' | 'day'
  session: string
}

/** 表の 1 文字の幅。全角は 2（端末で桁を揃えるためだけの目安） */
function charWidth(ch: string): number {
  const c = ch.codePointAt(0)!
  return c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f300)
    ? 2
    : 1
}

const textWidth = (s: string): number => [...s].reduce((w, ch) => w + charWidth(ch), 0)

/** 1 行にして幅で切る（切ったら `…`）。`max` が 0 なら切らない */
export function head(text: string | undefined, max: number): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  if (max <= 0 || textWidth(line) <= max) return line
  let out = ''
  let w = 0
  for (const ch of line) {
    w += charWidth(ch)
    if (w > max - 1) break
    out += ch
  }
  return `${out}…`
}

/** 桁を揃えた表。最後の列は詰めない */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((h, i) => Math.max(textWidth(h), ...rows.map((r) => textWidth(r[i] ?? ''))))
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c + ' '.repeat(widths[i]! - textWidth(c))))
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)]
}

const stampFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** `MM-DD HH:MM`（Asia/Tokyo）。読めなければそのまま */
export function stamp(ts: string | undefined): string {
  const d = new Date(ts ?? '')
  if (Number.isNaN(d.getTime())) return ts ?? ''
  const p = Object.fromEntries(stampFmt.formatToParts(d).map((x) => [x.type, x.value]))
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`
}

const KIND_MARK: Record<PromptKind, string> = { human: '', compact: '[要約] ', message: '', empty: '' }

/** 入力の頭。要約の文は人の入力ではないので印を付け、頭に足した返答の塊は外す */
function promptHead(userText: string | undefined, max: number): string {
  const kind = promptKind(userText)
  return KIND_MARK[kind] + head(kind === 'compact' ? userText : splitHandedReplies(userText ?? '').text, max)
}

const labelOf = (sessions: readonly SessionSummary[]) => {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  return (id: string): string => {
    const s = byId.get(id)
    return s ? head(sessionLabel(s), 24) : id
  }
}

function parse(argv: readonly string[], now: Date): { command: string; positionals: string[]; options: Options } | { error: string } {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        n: { type: 'string', short: 'n' },
        all: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        full: { type: 'boolean', default: false },
        days: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        by: { type: 'string', default: 'session' },
        session: { type: 'string', default: '' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  const { values, positionals } = parsed
  if (values.help) return { error: '' }
  if (positionals.length === 0) return { error: 'コマンドを指定してください' }
  const count = (name: string, raw: string | undefined, fallback: number): number | string => {
    if (raw === undefined) return fallback
    const v = Number(raw)
    return Number.isInteger(v) && v > 0 ? v : `${name} は 1 以上の整数で指定してください: ${raw}`
  }
  const n = count('-n', values.n, DEFAULT_ROWS)
  if (typeof n === 'string') return { error: n }
  const days = count('--days', values.days, DEFAULT_DAYS)
  if (typeof days === 'string') return { error: days }
  for (const key of ['from', 'to'] as const) {
    const v = values[key]
    if (v !== undefined && !isDate(v)) return { error: `--${key} は YYYY-MM-DD で指定してください: ${v}` }
  }
  if (values.by !== 'session' && values.by !== 'day') return { error: `--by は session か day です: ${values.by}` }
  const range = dateRange({ from: values.from, to: values.to, days }, now)
  if (range.from > range.to) return { error: `--from が --to より後です: ${range.from} > ${range.to}` }
  return {
    command: positionals[0]!,
    positionals: positionals.slice(1),
    options: { n, all: values.all, json: values.json, full: values.full, range, ranged: values.days !== undefined || values.from !== undefined || values.to !== undefined, by: values.by, session: values.session },
  }
}

const rangeNote = (r: DateRange): string => (r.from === r.to ? r.from : `${r.from}〜${r.to}`)

/** 絞ったことを 1 行で知らせる（全部出したのか一部なのかを読み違えないように） */
const shown = (count: number, total: number, unit: string): string => (count < total ? `${count} / ${total} ${unit}（--all で全部）` : `${total} ${unit}`)

/** セッションの指定を引く。決まらなければ候補を出して null */
function pick(sessions: readonly SessionSummary[], query: string, o: Options, io: Io): SessionSummary | null {
  const r = resolveSession(sessions, query)
  if (r.target) return r.target
  const candidates = r.candidates.slice(0, CANDIDATES_SHOW)
  const reason = r.ambiguous ? `「${query}」に当たるセッションが ${r.candidates.length} つあります。ID で選び直してください` : `「${query}」に当たるセッションがありません（${rangeNote(o.range)} の記録の中。--days で広げられます）`
  if (o.json) {
    io.out(JSON.stringify({ error: reason, candidates: candidates.map((s) => ({ id: s.id, label: sessionLabel(s), end: s.end, turns: s.turns })) }))
    return null
  }
  io.err(reason)
  for (const line of table(['ID', '呼び名', '最後の行', 'ターン'], candidates.map((s) => [s.id, head(sessionLabel(s), 40), stamp(s.end), String(s.turns)]))) io.err(line)
  if (r.candidates.length > candidates.length) io.err(`…ほか ${r.candidates.length - candidates.length} つ`)
  return null
}

async function rowsCommand(args: readonly string[], o: Options, io: Io): Promise<number> {
  const query = args[0] ?? ''
  if (!query) {
    io.err('セッションを指定してください: pnpm feed rows <ID・表示名・worktree 名・ID の頭>')
    return 2
  }
  const rows = await readRows(io.dir, o.range)
  const session = pick(sessionsOf(rows, await readMeta(io.dir)), query, o, io)
  if (!session) return 1
  const own = rows.filter((r) => rowEntity(r) === session.id)
  const picked = o.all ? own : own.slice(-o.n)
  const cells = (r: FeedRow) => ({
    ts: r.ts,
    event: r.event ?? '',
    kind: eventKind(r.event, r.text),
    user_text: o.full ? (r.user_text ?? '') : promptHead(r.user_text, 48),
    text: o.full ? (r.text ?? '') : head(r.text, 72),
  })
  if (o.json) {
    io.out(JSON.stringify({ id: session.id, label: sessionLabel(session), range: o.range, total: own.length, rows: picked.map(cells) }))
    return 0
  }
  io.out(`${session.id}「${head(sessionLabel(session), 40)}」 ${shown(picked.length, own.length, '行')}・${rangeNote(o.range)}`)
  // 表は 1 行 1 件のまま（--full でも改行は空白にする）
  const body = picked.map(cells).map((c) => [stamp(c.ts), c.kind, head(c.user_text, 0), head(c.text, 0)])
  for (const line of table(['時刻', '種類', '入力', '返答'], body)) io.out(line)
  return 0
}

async function messagesCommand(o: Options, io: Io): Promise<number> {
  const meta = await readMeta(io.dir)
  let messages = await readAgentMessages(io.dir)
  if (o.ranged) messages = messages.filter((m) => inRange(m.since, o.range))
  if (o.session) {
    const session = pick(sessionsOf(await readRows(io.dir, o.range), meta), o.session, o, io)
    if (!session) return 1
    messages = messages.filter((m) => m.from === session.id || m.to === session.id)
  }
  const total = messages.length
  const picked = o.all ? messages : messages.slice(-o.n)
  // 引き当ては、出すメッセージを送った日から今日までの行で見る（返答は送ったあとに来る。古いメッセージのために全部は読まない）
  const today = localDate(io.now.toISOString())
  const rows = await readRows(io.dir, { from: picked.reduce((min, m) => (localDate(m.since) < min ? localDate(m.since) : min), today), to: today })
  const label = labelOf(sessionsOf(rows, meta))
  const clip = (text: string | undefined, max: number) => (o.full ? (text ?? '') : head(text, max))
  const items = messageReplies(picked, rows).map(({ message: m, reply }) => ({
    message_id: m.message_id,
    since: m.since,
    from: m.from,
    from_label: label(m.from),
    to: m.to,
    to_label: label(m.to),
    text: clip(m.text, 48),
    replied_at: reply?.ts ?? '',
    reply: clip(reply?.text, 56),
    handed_at: m.handed_at ?? '',
  }))
  if (o.json) {
    io.out(JSON.stringify({ total, messages: items }))
    return 0
  }
  io.out(`送ったメッセージ ${shown(items.length, total, '件')}`)
  const body = items.map((m) => [stamp(m.since), m.from_label, m.to_label, head(m.text, 0), m.replied_at ? `${stamp(m.replied_at)} ${head(m.reply, 0)}` : '未着'])
  for (const line of table(['送った', '送り元', '宛先', '本文', '返答'], body)) io.out(line)
  return 0
}

const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

async function usageCommand(o: Options, io: Io): Promise<number> {
  // 差は絞る前の全部で取り、それから範囲で絞る（順を逆にすると、範囲の最初の行に積み上げが丸ごと乗る）
  const inWindow = usageRows(await readTurnUsage(io.dir)).filter((r) => inRange(r.ts, o.range))
  const totals = usageTotals(inWindow, o.by)
  const picked = o.all ? totals : o.by === 'day' ? totals.slice(-o.n) : totals.slice(0, o.n)
  const sum = usageTotals(inWindow.map((r) => ({ ...r, id: '合計' })), 'session')[0]
  if (o.json) {
    io.out(JSON.stringify({ range: o.range, by: o.by, total: totals.length, sum: sum ?? null, rows: picked }))
    return 0
  }
  const label = o.by === 'session' ? labelOf(sessionsOf(await readRows(io.dir, o.range), await readMeta(io.dir))) : (key: string) => key
  const cells = (t: (typeof totals)[number], name: string) => [name, String(t.turns), tokens(t.input_tokens), tokens(t.output_tokens), tokens(t.cache_read_input_tokens), tokens(t.cache_creation_input_tokens), t.cost_usd.toFixed(2)]
  io.out(`使用量（SAI から回したターンだけ）${rangeNote(o.range)}・${shown(picked.length, totals.length, o.by === 'day' ? '日' : 'セッション')}・費用は前の行との差（cost_usd は積み上げ）`)
  const body = picked.map((t) => cells(t, label(t.key)))
  for (const line of table([o.by === 'day' ? '日付' : 'セッション', 'ターン', '入力', '出力', 'キャッシュ読', 'キャッシュ書', '費用$'], sum ? [...body, cells(sum, '合計')] : body)) io.out(line)
  return 0
}

/** コマンドを 1 回実行する。返すのは終了コード（0 成功・1 決まらなかった・2 使い方の誤り） */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const parsed = parse(argv, io.now)
  if ('error' in parsed) {
    if (parsed.error) io.err(parsed.error)
    ;(parsed.error ? io.err : io.out)(USAGE)
    return parsed.error ? 2 : 0
  }
  const { command, positionals, options } = parsed
  if (command === 'rows') return rowsCommand(positionals, options, io)
  if (command === 'messages') return messagesCommand(options, io)
  if (command === 'usage') return usageCommand(options, io)
  io.err(`知らないコマンドです: ${command}`)
  io.err(USAGE)
  return 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), { dir: feedDir(), now: new Date(), out: (line) => console.log(line), err: (line) => console.error(line) })
}
