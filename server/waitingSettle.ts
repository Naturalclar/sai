// 端末（tmux）で人が答えたら、次のターンを待たずに行の「待ち」を畳む（#255。#232 の積み残し）。
//
// `SessionSummary.waiting` は「一番新しい行が待ちの行なら、その text」。許可や質問への回答は
// `UserPromptSubmit` ではないので `record.py` は再開の行を書かず、人が端末で答えても行は増えない。
// 次のターン完了まで「要対応」に居座り、そのターンが失敗して `Stop` が来なければ永久に残る。
//
// `server/codexDialogs.ts` の裏返し。あちらは「ペインを見て**ダイアログが出ていたら**待ちとして出す」、
// こちらは「ペインを見て**ダイアログが消えていたら**行の待ちを畳む」。
//
// **材料が無いのに待ちを消さない。** 畳むのは「ダイアログが消えている」とはっきり分かったときだけで、
// 読めない・ペインが無い・別のプロセスになった、は全部「残す」側に倒す（下の表）。
import { inspectPrompt } from './terminal.ts'
import type { PsFn, Tmux } from './terminal.ts'
import type { SessionSummary } from '../shared/types.ts'

export interface WaitingSettleSource {
  /** 待ちを畳んでよいエンティティIDの集合。見に行けなければ空 */
  scan(sessions: readonly SessionSummary[]): Promise<ReadonlySet<string>>
}

/** 何もしない実装（`SAI_TERMINAL=0` と、端末を見ないテスト） */
export class NoWaitingSettle implements WaitingSettleSource {
  scan(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set<string>())
  }
}

/**
 * 端末で開いていて、行の上では待っているセッションのペインを見る。
 *
 * | `inspectPrompt` の結果 | どうするか |
 * | --- | --- |
 * | `dialog` | まだ待っている → 残す |
 * | `idle` / `typed` | ダイアログが消えている＝人が答えた → **畳む** |
 * | `unknown`（入力欄が読めない） | 分からない → 残す |
 * | 例外（ペインが無い / pid が別物） | 分からない → 残す |
 *
 * **古い行の `pane` が SAI サーバのペインを指していても安全**（#234 以前に書かれた行）。
 * `isDescendant()` は通ってしまう（`-p` の子はサーバの子孫で、サーバはそのペインの子孫）が、
 * そのペインに `❯` は無いので `promptState()` が `unknown` を返し、上の表で「残す」に落ちる。
 */
export class WaitingSettle implements WaitingSettleSource {
  private scanning: Promise<ReadonlySet<string>> | null = null
  private readonly tmux: Tmux
  private readonly ps: PsFn

  constructor(tmux: Tmux, ps: PsFn) {
    this.tmux = tmux
    this.ps = ps
  }

  /** 3 秒のポーリングが重なっても、走っているスキャンは 1 本だけ（CodexDialogs と同じ） */
  scan(sessions: readonly SessionSummary[]): Promise<ReadonlySet<string>> {
    if (!this.scanning) {
      this.scanning = this.scanNow(sessions).finally(() => {
        this.scanning = null
      })
    }
    return this.scanning
  }

  private async scanNow(sessions: readonly SessionSummary[]): Promise<ReadonlySet<string>> {
    // 見るのは「端末で開いていて、行の上では待っている」ものだけ。普段は 0〜1 件
    const targets = sessions.filter((s) => s.waiting && s.terminal)
    const settled = await Promise.all(
      targets.map(async (session) => {
        try {
          const state = await inspectPrompt(this.tmux, this.ps, session.terminal!, session.agent)
          // ダイアログが消えていれば人が答えた。読めない（unknown）ときは畳まない
          return state.kind === 'idle' || state.kind === 'typed' ? session.id : null
        } catch {
          // ペインが無い・pid が別物・capture 失敗。分からないので待ちはそのまま
          return null
        }
      }),
    )
    return new Set(settled.filter((id): id is string => id !== null))
  }
}

/**
 * 畳んだぶんの `waiting` を空にする。**行（集計）は触らず、応答を組み立てるときだけ**
 * （`terminal` を載せるのと同じ形）。ここで空にすると、要対応・サイドバーの「待機中」・
 * チャット見出しが**まとめて**正しくなる（`todoItems()` だけを直すと 3 か所が食い違う）
 */
export function clearSettled(sessions: SessionSummary[], settled: ReadonlySet<string>): SessionSummary[] {
  if (settled.size === 0) return sessions
  return sessions.map((s) => (s.waiting && settled.has(s.id) ? { ...s, waiting: '' } : s))
}

/** rev に混ぜる鍵。畳んだ集合が変われば画面のポーリングが拾う */
export function settledKey(settled: ReadonlySet<string>): string {
  return [...settled].sort().join(',')
}
