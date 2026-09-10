import type { ReactNode } from 'react'
import type { Profile } from './api'
import { elapsedLabel, hm, LONG_REPLY_MS, parseTs } from './format'
import { AttachedImages } from './AttachedImages'
import { splitAttachments } from '../../shared/attachments.ts'

/**
 * 処理中の返信の仮バブル。サーバの replying（か送った直後のローカル）から出し、フックで行が届いたら
 * useReply の pending から外れて消える（届いた行の user_text が本物になる）。quiet なら本文を出さない
 * （入力の行が先に届いて本物の自分バブルがもう出ている）。フィードでは repo を渡して
 * チャンネル名を添える。since からの経過を出し、長引いていれば色を変える。now はポーリングの updatedAt。
 * children は「処理中」の横に並べるもの（いま何をしているか。`ProgressSteps`。#302）。
 * typed は端末で打ったターン（SAI が送った返信ではない。#302）で、title の言い回しだけ変える
 */
export function PendingBubble({ text, since, now, repo, quiet, profile, typed, children }: { text: string; since: string; now: number; repo?: string; quiet?: boolean; profile?: Profile; typed?: boolean; children?: ReactNode }) {
  const started = parseTs(since)?.getTime() ?? now
  const long = now - started > LONG_REPLY_MS
  const elapsed = elapsedLabel(since, now)
  const sent = typed ? `${hm(since)} に端末で入力` : `${hm(since)} に送信`
  if (quiet) {
    // 入力の行（UserPromptSubmit）が届いて本物の自分バブルが出ている。本文は重ねず「処理中」の1行だけ
    return (
      <div className={`pending-line${long ? ' long' : ''}`} title={sent}>
        <span>⏳</span>
        {repo && <span className="ch">#{repo}</span>}
        <span className="time">{elapsed ? `処理中 ${elapsed}` : '処理中…'}</span>
        {children}
      </div>
    )
  }
  return (
    <div className={`group pending${long ? ' long' : ''}`}>
      <div className="avatar me">{profile?.icon ? <img src={profile.icon} alt="" /> : '私'}</div>
      <div>
        <div className="gh">
          <span className="name">{profile?.name || 'あなた'}</span>
          {repo && <span className="ch">#{repo}</span>}
          <span className="time" title={sent}>{elapsed ? `処理中 ${elapsed}` : '送信中…'}</span>
          {children}
        </div>
        <div className="msg">
          <div className="body">{splitAttachments(text).body}</div>
          <AttachedImages urls={splitAttachments(text).urls} />
        </div>
      </div>
    </div>
  )
}
