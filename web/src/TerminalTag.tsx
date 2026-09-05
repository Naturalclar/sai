import type { Terminal } from '../../shared/types.ts'

/** 端末（tmux）で開いている。SAI からの返信はこのペインに打ち込まれる */
export function TerminalTag({ terminal }: { terminal: Terminal }) {
  return (
    <span className="tag terminal" title={`tmux のペイン ${terminal.pane}（pid ${terminal.pid}）で開いている。返信はここに打ち込む`}>
      端末
    </span>
  )
}
