import type { TurnOutputSection } from './api'
import { diffLineKind } from '../../shared/turnOutput.ts'

/** 本文を 1 つの `<pre>` に。**文字として描く**（HTML にしない）。差分は行ごとに色を付ける */
function body(text: string, kind: TurnOutputSection['kind']) {
  if (kind !== 'diff') return <pre>{text}</pre>
  return (
    <pre>
      {text.split('\n').map((line, i) => (
        <span key={i} className={diffLineKind(line)}>
          {line}
        </span>
      ))}
    </pre>
  )
}

/** 手順の出力・差分の 1 節（#846）。長ければ頭と末尾だけで、間の字数を出す */
export function OutputSection({ section }: { section: TurnOutputSection }) {
  const { label, kind, text, tail, omitted, exit_code: exitCode, failed, withheld } = section
  return (
    <div className="out-section">
      <div className="out-label">
        {label}
        {exitCode !== undefined && <span className="bad">終了コード {exitCode}</span>}
        {exitCode === undefined && failed && <span className="bad">失敗</span>}
      </div>
      {withheld && <div className="note">秘密に見えるファイルなので、中身は出しません</div>}
      {!withheld && !text && !tail && <div className="note">出力はありません</div>}
      {!withheld && text && body(text, kind)}
      {(omitted ?? 0) > 0 && <div className="omitted">… {omitted?.toLocaleString()} 字を省きました …</div>}
      {!withheld && tail && body(tail, kind)}
    </div>
  )
}
