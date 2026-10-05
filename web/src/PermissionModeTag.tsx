import { modeEmphasis, modeLabel } from '../../shared/permissions.ts'

/**
 * 許可モードの印。`default`（通常）と空のときは呼び出し側が出さない。
 * ルールに関係なく通るモードは色を変える（素通しは赤、Auto mode は 1 段弱い色。#691）
 */
export function PermissionModeTag({ mode }: { mode: string }) {
  return (
    <span className={`tag mode ${modeEmphasis(mode)}`.trimEnd()} title={`許可モード: ${modeLabel(mode)}`}>
      {mode}
    </span>
  )
}
