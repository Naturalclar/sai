import { useState } from 'react'
import { mayCross, pairLabel, SEND_ACROSS_MAX } from '../../shared/sendAcross.ts'
import type { SettingsRequest, SettingsResponse } from './api'

interface Props {
  settings: SettingsResponse
  busy: boolean
  onChange: (patch: SettingsRequest) => void
}

/**
 * 自分のメニューの「別のリポジトリへ送る」（#747）。エージェントの `sai_send` が、どのリポジトリからどのリポジトリへ送ってよいかを
 * 人が決める。**既定は空**（同じリポジトリの中だけ）。組は向きつきで、選べるのは記録で知っているリポジトリだけ（名前は打たせない）。
 * 変えられるのはここ（同一オリジンの PUT）だけで、エージェントの道具からは増やせない
 */
export function SendAcrossControls({ settings, busy, onChange }: Props) {
  // 古いサーバ（send_across を返さない）に当たったら、欄ごと出さない
  const pairs = settings.send_across
  const projects = settings.send_across_projects
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  if (!pairs || !projects) return null
  const ready = Boolean(from && to && from !== to && !mayCross(pairs, from, to) && pairs.length < SEND_ACROSS_MAX)
  return (
    <div className="send-across-controls">
      <div className="send-across-title">別のリポジトリへ送る（エージェントの sai_send）</div>
      {pairs.length === 0 ? (
        <div className="note">いまは同じリポジトリの中だけ送れます</div>
      ) : (
        <ul className="send-across-list">
          {pairs.map((p) => (
            <li key={`${p.from}\n${p.to}`}>
              <span className="pair">{pairLabel(p)}</span>
              <button type="button" className="linkish" disabled={busy} onClick={() => onChange({ send_across: pairs.filter((x) => x !== p) })}>
                やめる
              </button>
            </li>
          ))}
        </ul>
      )}
      {projects.length >= 2 && (
        <div className="send-across-add">
          <select value={from} disabled={busy} aria-label="送り元のリポジトリ" onChange={(e) => setFrom(e.target.value)}>
            <option value="">送り元…</option>
            {projects.map((p) => (
              <option key={`from:${p}`} value={p}>{p}</option>
            ))}
          </select>
          <span aria-hidden="true">→</span>
          <select value={to} disabled={busy} aria-label="宛先のリポジトリ" onChange={(e) => setTo(e.target.value)}>
            <option value="">宛先…</option>
            {projects.filter((p) => p !== from).map((p) => (
              <option key={`to:${p}`} value={p}>{p}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || !ready}
            onClick={() => {
              onChange({ send_across: [...pairs, { from, to }] })
              setTo('')
            }}
          >
            許す
          </button>
        </div>
      )}
      <div className="note warn">
        許した向きにだけ送れます（逆向きは別に許す）。宛先が許可を聞かないモード（Bypass / Auto）でも送れるので、送り元のエージェントが読んだ文に指示が混ざっていると、宛先のリポジトリまで届きます
      </div>
    </div>
  )
}
