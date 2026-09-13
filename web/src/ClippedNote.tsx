/**
 * 本文が record.py に切られていることの印（#358）。
 * 折りたたみを全部開いても続きが無いので、「そこで終わった」のと見分けが付くようにする
 */
export function ClippedNote() {
  return (
    <div className="clipped-note" title="長すぎるので記録のときに切られています（~/.agent-feed の行。上限は feed/record.py）">
      ここで切れています
    </div>
  )
}
