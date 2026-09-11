// サイドバーのセッションの 2 行目（最後の発言）に何を出すか（#300）。DOM に依存しないので node:test で回す（sessionPreview.test.ts）
import type { Profile, Replying, SessionSummary } from '../../shared/types.ts'
import { stripMarkdown } from '../../shared/markdown.ts'
import { splitAttachments } from '../../shared/attachments.ts'

export interface SessionPreview {
  /** 誰の発言か。自分の返信なら `me` */
  from: 'me' | 'agent'
  /** 自分の発言に添える名前（プロフィールの名前、無ければ「あなた」。チャットの `speakerLabel()` と同じ）。エージェントなら省略 */
  who?: string
  text: string
}

type PreviewSource = Pick<SessionSummary, 'turns' | 'last_text' | 'last_summary' | 'last_turn_ts' | 'last_user_text' | 'last_user_ts'>

/** 時刻を比べられる数にする。読めなければ一番古い扱い */
const at = (ts: string | undefined): number => {
  const n = Date.parse(ts ?? '')
  return Number.isNaN(n) ? Number.NEGATIVE_INFINITY : n
}

/** 自分の入力の 1 行目。SAI から画像を添えた返信は本文の末尾にパスが足してあるので落とす（shared/attachments.ts） */
const firstLine = (text: string): string => splitAttachments(text).body.split('\n').map((l) => l.trim()).find(Boolean) ?? ''

/**
 * 2 行目に出すもの。**そのセッションで最後に誰が何を言ったか**を出す（チャットアプリの一覧と同じ）。
 *
 * - **自分の返信**: ターンが 1 回以上終わったあとの入力が、最後のターン完了より新しければそれ。見るのは 2 つで、
 *   SAI から送った返信（`replying.text`。どのエージェントでも送った瞬間に分かる。失敗したものは届いていないので見ない）と、
 *   記録された入力（`last_user_text`。Claude は入力した瞬間に行が届く。Codex / OpenCode はターン完了の行に一緒に載るので、
 *   ターン完了と同じ時刻になり、エージェントの返答の方が出る）。
 *   **最初の指示は出さない**（1 行目の題名と同じ文を 2 行並べるだけになる）
 * - **エージェントの返答**: 今までどおり `turns > 1` のときだけ。一言（digest）があればそれ。一言はエージェントの発言にだけ使う
 * - どちらも無ければ null（2 行目を出さない）
 */
export function sessionPreview(s: PreviewSource, replying: Replying | null, profile?: Profile): SessionPreview | null {
  const mine = (text: string): SessionPreview => ({ from: 'me', who: profile?.name || 'あなた', text })
  const lastTurn = at(s.last_turn_ts)
  if (s.turns >= 1) {
    if (replying && !replying.failed) {
      const text = firstLine(replying.text)
      if (text && at(replying.since) > lastTurn) return mine(text)
    }
    const typed = s.last_user_text ? firstLine(s.last_user_text) : ''
    if (typed && at(s.last_user_ts) > lastTurn) return mine(typed)
  }
  if (s.turns > 1) {
    // 一言も LLM が本文から Markdown（`[名前](パス)` など）を写すので、同じく記号を落とす（#321）
    const text = stripMarkdown(s.last_summary ?? '') || stripMarkdown(s.last_text)
    if (text) return { from: 'agent', text }
  }
  return null
}
