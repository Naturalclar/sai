import type { ReplaceConfirm } from './useReply.ts'

/** サーバが別経路（Claude の resume / Codex の queue）を許したときだけ逃げ道を出す。 */
export const showProcessOption = (confirm: Pick<ReplaceConfirm, 'canProcess'>): boolean => confirm.canProcess
