// 許可ルールの並びと言い換え。サーバ（server/permissions.ts の並べ替え）と画面（PermissionsModal）が同じ値を使う。
import type { PermissionKind, PermissionMode, PermissionSourceKind } from './types.ts'

/**
 * ルールの評価順。deny → ask → allow の順に見て、最初に当たったものが決まる（ルールの細かさは順に関係しない）。
 * deny は**どのスコープのものでも** allow に勝つ
 */
export const PERMISSION_KINDS: PermissionKind[] = ['deny', 'ask', 'allow']

/** 設定の強い順。コマンドライン（`claude --settings`）は端末側の起動引数なので SAI からは見えず、ここには無い */
export const SOURCE_ORDER: PermissionSourceKind[] = ['managed', 'local', 'project', 'user', 'sai_args']

export const KIND_LABEL: Record<PermissionKind, string> = {
  deny: '拒否',
  ask: '毎回聞く',
  allow: '許可',
}

export const SOURCE_LABEL: Record<PermissionSourceKind, string> = {
  managed: '組織',
  local: 'ローカル',
  project: 'プロジェクト',
  user: 'ユーザー',
  sai_args: 'SAI の引数',
}

export const SOURCE_HINT: Record<PermissionSourceKind, string> = {
  managed: '組織が配っている設定。個人の設定では上書きできない',
  local: 'このセッションの作業ディレクトリの .claude/settings.local.json。画面の [常に許可] が書く先',
  project: 'リポジトリにコミットされている .claude/settings.json',
  user: '~/.claude/settings.json。全セッション共通',
  sai_args: '環境変数 SAI_CLAUDE_ARGS。SAI から返信したターンにだけ効く（端末で打ったターンには効かない）',
}

/** 許可モードの言い換え。値は Claude Code のフックのペイロードの permission_mode そのまま */
export const MODE_LABEL: Record<PermissionMode, string> = {
  default: '通常（読み取り以外は聞く）',
  acceptEdits: 'ファイル編集は聞かない',
  plan: 'プラン（承認するまで書き換えない）',
  auto: '自動（安全性の確認つきで何でも実行）',
  dontAsk: '聞かない（許可済みだけ実行し、他は自動で拒否）',
  bypassPermissions: '全部素通し（許可の確認をしない）',
}

/** ルールの一覧に関係なく通ってしまうモードか。画面で目立たせる */
export function modeSkipsRules(mode: string): boolean {
  return mode === 'auto' || mode === 'bypassPermissions'
}

/** 知らない値でも落とさずそのまま出す */
export function modeLabel(mode: string): string {
  return MODE_LABEL[mode as PermissionMode] ?? mode
}
