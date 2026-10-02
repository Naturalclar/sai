import { contextLabel } from '../../shared/contextSize.ts'
import type { UsageReportRow, UsageSessionRow } from './api'
import { sessionHash } from './hooks'
import { dayLabel, modelLabel } from './usageReportLabels'

/** 使用量の表の何別か（#602） */
export type UsageTableKind = 'session' | 'day' | 'model'

/**
 * 使用量の表の 1 列目（#602）。セッションは呼び名（無ければ ID）をそのセッションへのリンクにし、
 * 読み直しが大きいものに印を付ける（区切りはコンテキストの注意 #441 と同じ）
 */
export function UsageRowLabel({ kind, row }: { kind: UsageTableKind; row: UsageReportRow }) {
  if (kind === 'day') return <span title={row.key}>{dayLabel(row.key)}</span>
  if (kind === 'model') return <span title={row.key}>{modelLabel(row.key)}</span>
  const s = row as UsageSessionRow
  return (
    <>
      <a href={sessionHash(s.key)} title={s.key}>{s.name || s.key}</a>
      {s.heavy && (
        <span className="tag heavy" title={`モデルを 1 回呼ぶたびに平均 ${contextLabel(s.read_per_call)} トークンを読み直しています。新しいセッションに切り替えると軽くなります`}>
          読み直し大
        </span>
      )}
    </>
  )
}
