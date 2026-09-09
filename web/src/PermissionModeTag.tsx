import { modeLabel, modeSkipsRules } from '../../shared/permissions.ts'

/**
 * 許可モードの印。`default`（通常）と空のときは呼び出し側が出さない。
 * ルールに関係なく通るモード（auto / bypassPermissions）は色を変える
 */
export function PermissionModeTag({ mode }: { mode: string }) {
  const loud = modeSkipsRules(mode)
  return (
    <span className={`tag mode${loud ? ' loud' : ''}`} title={`許可モード: ${modeLabel(mode)}`}>
      {mode}
    </span>
  )
}
