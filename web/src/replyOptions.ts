import type { ReplaceConfirm } from './useReply.ts'

/** 開いている Codex は別プロセスの resume と競合するので、サーバが許したときだけ逃げ道を出す。 */
export const showProcessOption = (confirm: Pick<ReplaceConfirm, 'canProcess'>): boolean => confirm.canProcess
