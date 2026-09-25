// Codex のターンがエラーで終わったことを拾う（#475）。
//
// **エラーで終わったターンでは Codex は `notify` を鳴らさない**（codex 0.154.0 で実測。使い捨ての CODEX_HOME で、
// 無いモデルを指定したターンは `turn/completed` が `status: "failed"` になり、rollout の `task_complete` に `error` が付き、
// notify は呼ばれなかった。同じ手順の成功したターンでは鳴る）。そのため record.py は呼ばれず、**行が 1 本も残らない**。
// 実データでは queue に渡した返信のうち 2 件が `You've hit your usage limit.` で終わっていて、画面からは
// 「送ったのに返事が来ない」だけに見えていた（9 月の rollout で、エラーで終わったターンは 2 件とも行が無く、
// 成功したターンは 82 件すべて行があった）。
//
// 行は record.py の側で起こせないので、**SAI の画面に失敗として出す**のが直し方になる。
// 端末に打ち込んだ・queue に渡した返信は rollout の `task_complete.error` で、SAI の app-server で回した返信は
// `turn/completed` の `turn.error` で見る。どちらも中身は同じ形（`{ message, codexErrorInfo, … }`）。

import { queuedKey } from './codexQueue.ts'

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/**
 * Codex のターンのエラー（`task_complete.error` / `turn/completed` の `turn.error`）を人が読める 1 行にする。
 * `message` は素の文（`You've hit your usage limit. …`）のことも、API の応答の JSON を文字列にしたもの
 * （`{"type":"error","status":400,"error":{"message":"…"}}`）のこともあるので、JSON なら中の `message` を採る。
 * エラーでなければ空
 */
export function codexErrorText(error: unknown): string {
  const raw = record(error)?.message
  if (typeof raw !== 'string' || !raw.trim()) return ''
  const text = raw.trim()
  if (text.startsWith('{')) {
    try {
      const parsed = record(JSON.parse(text))
      const inner = record(parsed?.error)?.message ?? parsed?.message
      if (typeof inner === 'string' && inner.trim()) return inner.trim()
    } catch {
      // JSON に見えて壊れていれば、そのまま出す
    }
  }
  return text
}

/**
 * 送った本文（`text`）が `sinceMs` より後に人の入力として載り、**そのあとに来たターンの終わりがエラー**なら、そのエラーの文。
 * まだ終わっていない・エラーなく終わった・人が止めた（`turn_aborted`）・本文が読んだ範囲に無いときは null
 * （**分からないときは失敗にしない**。#474 の「届いたか」と同じ作法）
 */
export function queuedTurnError(lines: readonly string[], text: string, sinceMs: number): string | null {
  const key = queuedKey(text)
  if (!key) return null
  let arrived = false
  for (const line of lines) {
    if (!line.trim()) continue
    let entry: Record<string, unknown> | null
    try {
      entry = record(JSON.parse(line))
    } catch {
      continue
    }
    if (!entry) continue
    const payload = record(entry.payload)
    if (!arrived) {
      if (typeof entry.timestamp !== 'string' || !(Date.parse(entry.timestamp) >= sinceMs - 2_000)) continue
      if (userInput(entry, payload)?.includes(key)) arrived = true
      continue
    }
    if (entry.type !== 'event_msg') continue
    if (payload?.type === 'turn_aborted') return null
    if (payload?.type === 'task_complete') return codexErrorText(payload.error) || null
  }
  return null
}

/** rollout の 1 行が人の入力なら、揃えた本文（`queuedKey()` と同じ揃え方）。入力でなければ null */
function userInput(entry: Record<string, unknown>, payload: Record<string, unknown> | null): string | null {
  if (!payload) return null
  let text: string | null = null
  if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
    text = payload.content.map((block) => (typeof record(block)?.text === 'string' ? (record(block)?.text as string) : '')).join('')
  } else if (entry.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
    text = payload.message
  }
  return text === null ? null : text.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** 画面に出す文。エラーの文のあとに、行が残らない理由と次の一手を添える */
export function codexTurnErrorReason(message: string): string {
  return `Codex のターンがエラーで終わりました: ${message}（エラーで終わったターンは Codex が notify を鳴らさないので、記録の行は残りません）`
}
