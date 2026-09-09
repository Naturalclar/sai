/**
 * 別のマシンで記録されたセッションの印（#114）。一覧の項目・チャット見出し・フィードのバブルに出す。
 * 出すかどうかは呼ぶ側が `isRemoteHost()` で決める（自分のマシンには何も出さない）
 */
export function HostTag({ host }: { host: string }) {
  return (
    <span className="tag host" title={`${host} で記録されたセッション。ここからは返信できません`}>
      @{host}
    </span>
  )
}
