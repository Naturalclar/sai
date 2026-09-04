// チャットの行をバブルの塊にまとめる。DOM に依存しないので node:test で回す（chatGroups.test.ts）
import type { FeedRow, Profile, SessionSummary } from '../../shared/types.ts'
import { entityId } from '../../shared/entity.ts'
import { eventKind } from '../../shared/events.ts'
import { dayLabel, minutesBetween, parseTs, ymd } from './format.ts'

/** 発言者。自分（ターンの入力）か、エージェント */
export type Speaker = 'me' | FeedRow['agent']

/**
 * 1つのバブル。1行（= 1ターン）は「自分の入力（user_text）」と「エージェントの返答（text）」の
 * 2つの発言に展開する。user_text が無い行（古い JSONL など）はエージェントの発言だけ。
 * Claude は入力した瞬間に UserPromptSubmit の行（user_text だけ）が先に届くので、自分の発言はそこで立て、
 * 続くターン完了の行に載っている同じ入力は重ねない
 */
export interface Utterance {
  speaker: Speaker
  row: FeedRow
  text: string
  key: string
  /** 待ちの行（許可待ち・質問待ち）。text は「何を待っているか」で、Markdown にしない */
  waiting?: boolean
  /** 待ちの行で、後に同じセッションの行が来ている（= もう解消している）。薄く出す */
  resolved?: boolean
  /** エージェントの発言で、そのターンの思考があればそれ。セッション画面だけが出す */
  thinking?: string
  /** エージェントの発言の一言版（digest）。あればバブルの本文はこれで、元の text は「詳細」で開く */
  summary?: string
}

export interface Group {
  speaker: Speaker
  repo: string
  branch: string
  session: string
  firstTs: string
  lastTs: string
  items: Utterance[]
}

export interface DayGroups {
  day: string
  label: string
  groups: Group[]
}

const GROUP_GAP_MIN = 10

export function toUtterances(rows: FeedRow[]): Utterance[] {
  // 待ちが解消したかは「同じエンティティの行が後にあるか」で見る。最後の行の位置を先に控える
  const lastIndex = new Map<string, number>()
  rows.forEach((row, index) => lastIndex.set(entityId(row.session, row.repo, row.ts), index))

  // エンティティごとに、入力の行で出した直近の入力。次のターン完了の行に同じ入力が載っていたら重ねない
  const prompted = new Map<string, string>()

  const out: Utterance[] = []
  rows.forEach((row, index) => {
    const id = entityId(row.session, row.repo, row.ts)
    const kind = eventKind(row.event)
    const mine = (row.user_text ?? '').trim()
    if (kind === 'resume') {
      // 入力した瞬間の行。user_text があれば自分の発言。無い（合図だけの古い形）ならバブルにしない
      if (mine) {
        out.push({ speaker: 'me', row, text: row.user_text ?? '', key: `${row.ts}:${index}:me` })
        prompted.set(id, mine)
      }
      return
    }
    if (kind === 'waiting') {
      const resolved = (lastIndex.get(id) ?? index) > index
      out.push({ speaker: row.agent, row, text: row.text ?? '', key: `${row.ts}:${index}`, waiting: true, resolved })
      return
    }
    if (mine && prompted.get(id) !== mine) out.push({ speaker: 'me', row, text: row.user_text ?? '', key: `${row.ts}:${index}:me` })
    prompted.delete(id)
    const theirs: Utterance = { speaker: row.agent, row, text: row.text ?? '', key: `${row.ts}:${index}` }
    if (row.thinking?.trim()) theirs.thinking = row.thinking
    if (row.summary?.trim()) theirs.summary = row.summary
    out.push(theirs)
  })
  return out
}

/** 時計のずれの許容。since はサーバが起動した時刻、行の ts はフックが書いた時刻で、同じマシンだが順序は保証しない */
const PROMPT_SLACK_MS = 60_000

/**
 * 画面から送った返信（text）が、入力の行（UserPromptSubmit）として届いているか。
 * 届いていれば仮バブルの本文はもう要らない（本物の自分バブルが出ている）ので、「処理中」の1行だけにする
 */
export function promptArrived(rows: FeedRow[], id: string, text: string, since: string): boolean {
  const want = text.trim()
  const from = (parseTs(since)?.getTime() ?? 0) - PROMPT_SLACK_MS
  return rows.some(
    (r) =>
      eventKind(r.event) === 'resume' &&
      (r.user_text ?? '').trim() === want &&
      entityId(r.session, r.repo, r.ts) === id &&
      (parseTs(r.ts)?.getTime() ?? 0) >= from,
  )
}

/** Slack と同じ: 同じ発言者（speaker+session）が10分以内に続けば1つにまとめる */
export function groupRows(rows: FeedRow[]): DayGroups[] {
  const days: DayGroups[] = []
  let current: Group | null = null
  for (const u of toUtterances(rows)) {
    const { row } = u
    const day = ymd(row.ts)
    let bucket = days[days.length - 1]
    if (!bucket || bucket.day !== day) {
      bucket = { day, label: dayLabel(row.ts), groups: [] }
      days.push(bucket)
      current = null
    }
    const same =
      current &&
      current.speaker === u.speaker &&
      current.repo === row.repo &&
      current.session === row.session &&
      minutesBetween(current.lastTs, row.ts) < GROUP_GAP_MIN
    if (same && current) {
      current.items.push(u)
      current.lastTs = row.ts
    } else {
      current = { speaker: u.speaker, repo: row.repo, branch: row.branch, session: row.session, firstTs: row.ts, lastTs: row.ts, items: [u] }
      bucket.groups.push(current)
    }
  }
  return days
}

export const AGENT_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex CLI', unknown: 'unknown' }
export const AGENT_INITIAL: Record<string, string> = { claude: 'C', codex: 'X', unknown: '?' }

/** バブルの見出しに出す発言者。name は名前、mark は頭文字、icon は画像の URL（あれば mark の代わりにアバターに出す） */
export interface SpeakerLabel {
  name: string
  mark: string
  icon?: string
}

/**
 * 発言者の名前とアバター。自分は profile（ヘッダーのメニューで付けた表示名・アイコン）、無ければ「あなた」/「私」。
 * エージェント側は、そのセッションに表示名・アイコン画像が付いていればそれ、無ければエージェントの固定値（Claude Code / C など）。
 * session はセッション一覧（SessionSummary）から引く。一覧の窓に無いセッションの行がフィードに出ることがあるので、
 * 引けなければ固定値に落ちる
 */
export function speakerLabel(speaker: Speaker, session: Pick<SessionSummary, 'meta' | 'icon'> | undefined, profile?: Profile): SpeakerLabel {
  if (speaker === 'me') {
    const me: SpeakerLabel = { name: profile?.name || 'あなた', mark: '私' }
    if (profile?.icon) me.icon = profile.icon
    return me
  }
  const out: SpeakerLabel = {
    name: session?.meta?.name || AGENT_LABEL[speaker] || speaker,
    mark: AGENT_INITIAL[speaker] || '?',
  }
  if (session?.icon) out.icon = session.icon
  return out
}
