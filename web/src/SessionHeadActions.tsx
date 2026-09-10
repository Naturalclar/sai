import type { SessionSummary, SettingsResponse } from './api'
import { ArchiveButton } from './ArchiveButton'
import { MetaEditor } from './MetaEditor'
import { PermissionsButton } from './PermissionsButton'
import { SessionPersonaSelect } from './SessionPersonaSelect'

interface Props {
  s: SessionSummary
  settings: SettingsResponse | null
  /** 思考の折りたたみ。思考のある行が 1 つも無ければトグルは出さない */
  thinking: { has: boolean; open: boolean; toggle: () => void }
}

/**
 * チャット見出しの「操作」（アーカイブ・表示名とアイコン・許可されているもの・一言の性格・思考を全部開く）。
 * 広い画面では見出しにそのまま並び、狭い画面では「⋯」のパネルの中に入る（#274）
 */
export function SessionHeadActions({ s, settings, thinking }: Props) {
  return (
    <>
      {/*
        key は「別のセッションに移ったら作り直す」ため（中に持っている編集中の状態を持ち越さない）。
        **兄弟どうしで同じ key にしない**（#264）。同じ親の中で key が重なると React の再調整が
        古い分を見つけられず、ポーリングのたびに増え続ける（手元では 3 秒ごとに +3 で、見出しが
        「表示名なし」と許可モードの列で埋まった）。接頭辞を付けて 1 つずつ別の key にする。
        合成 ID（synth）でも出す（#248）。アーカイブは表示の都合なので、再開できるかとは別
      */}
      <ArchiveButton key={`archive:${s.id}:${s.archived ? 1 : 0}`} id={s.id} archived={Boolean(s.archived)} />
      <MetaEditor key={`meta:${s.id}`} id={s.id} meta={s.meta} icon={s.icon} />
      {s.agent === 'claude' && <PermissionsButton key={`perm:${s.id}`} id={s.id} />}
      {/* 一言が有効なときだけ。このセッションの性格（無ければヘッダの既定に従う） */}
      {settings?.digest && <SessionPersonaSelect key={`persona:${s.id}`} id={s.id} value={s.meta?.persona} off={Boolean(s.meta?.digest_off)} defaultPersona={settings.persona} />}
      {thinking.has && (
        <span className="meta">
          <button type="button" className="linkish" onClick={thinking.toggle} title="エージェントの思考（thinking）の折りたたみを全部開く／閉じる">
            {thinking.open ? '思考を全部閉じる' : '思考を全部開く'}
          </button>
        </span>
      )}
    </>
  )
}
