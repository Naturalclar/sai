// 許可ルールの並びと言い換え。サーバ（server/permissions.ts の並べ替え）と画面（PermissionsModal）が同じ値を使う。
import type { PermissionKind, PermissionMode, PermissionSourceKind, Replying, ReplyPermissionMode } from './types.ts'

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

/**
 * 許可モードの名前。値は Claude Code のフックのペイロードの permission_mode そのまま。
 * **名前は英語**（#271）: Claude Code 自身が端末の Shift+Tab で出す言い回し（`accept edits on` /
 * `bypass permissions on` / `plan mode on` など。2.1.266 のバイナリで確認）に揃え、端末と SAI で
 * 同じモードが別の名前に見えないようにする。UI 文言を日本語で書く方針の例外で、**例外は名前だけ**。
 * 何が起きるかの説明は `MODE_HINT`（日本語）に分けてある
 */
export const MODE_LABEL: Record<PermissionMode, string> = {
  default: 'Default',
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
  auto: 'Auto mode',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
}

/** そのモードで何が起きるか（日本語）。メニューの補足と、見出しのタグ・モーダルの説明に使う */
export const MODE_HINT: Record<PermissionMode, string> = {
  default: '読み取り以外は聞く',
  acceptEdits: 'ファイル編集は聞かない',
  plan: '承認するまで書き換えない',
  auto: '安全性の確認つきで何でも実行',
  dontAsk: '許可済みだけ実行し、他は自動で拒否',
  bypassPermissions: '許可の確認をしない',
}

/**
 * SAI の画面（入力欄の許可モードのボタン）から選べる許可モード。サーバの検査（shared/meta.ts の mergeMeta）と
 * 画面のメニューが同じ一覧を見るので、**ここに無い値は口としても受けない**（400）。
 * `bypassPermissions` は素通しなので、画面は modeSkipsRules() で目立たせる（#253）
 */
export const REPLY_MODES: ReplyPermissionMode[] = ['acceptEdits', 'bypassPermissions']

/**
 * 入力欄の許可モードのボタン（閉じているとき）に出す短い名前（#265）。
 * 送信ボタンの左にモデルと並ぶので幅が限られる。メニューの中は `MODE_LABEL` の名前と `MODE_HINT` の説明。
 * `MODE_LABEL` と同じく英語（#271）
 */
export const MODE_SHORT: Record<'default' | ReplyPermissionMode, string> = {
  default: 'Default',
  acceptEdits: 'Accept edits',
  bypassPermissions: 'Bypass',
}

/** 空（CLI の既定）は `default` と同じ扱い。知らない値はそのまま出す */
export function shortReplyMode(mode: string): string {
  const key = (mode || 'default') as keyof typeof MODE_SHORT
  return MODE_SHORT[key] ?? mode
}

/** 画面から選べる許可モードか。知らない値・素通し系は false */
export function isReplyPermissionMode(value: unknown): value is ReplyPermissionMode {
  return typeof value === 'string' && (REPLY_MODES as string[]).includes(value)
}

/** ルールの一覧に関係なく通ってしまうモードか。画面で目立たせる */
export function modeSkipsRules(mode: string): boolean {
  return mode === 'auto' || mode === 'bypassPermissions'
}

/** 名前と説明（`Accept edits — ファイル編集は聞かない`）。知らない値でも落とさずそのまま出す */
export function modeLabel(mode: string): string {
  const name = MODE_LABEL[mode as PermissionMode]
  if (!name) return mode
  return `${name} — ${MODE_HINT[mode as PermissionMode]}`
}

/**
 * 処理中のターンが、いまの設定と**違う**許可モードで動いているときの一言（#272）。違わなければ空。
 *
 * 許可モードは `claude -p` を起動するときのフラグでしか渡せず、動いている CLI には後から当てられない。
 * 処理中に「素通し」へ変えても、そのターンは起動したときのモードのまま許可を聞いてくるので、
 * 何も出さないと「素通しにしたのに聞かれる」ように見える。
 *
 * `current` はセッションのメタの `permission_mode`（無ければ undefined = CLI の既定）。空と `default` は同じ扱い。
 * 起動したときのモードが分からない返信（`permission_mode` が無い）、失敗して残っているだけの返信、
 * 端末に打ち込んだ返信（そもそもフラグが効かない）には出さない。
 *
 * 名前は `MODE_LABEL` の英語（#271。端末の Shift+Tab と同じ言い回し）。ボタンの `shortReplyMode()` と違って
 * バブルと title に出すので幅の制約が無く、`Bypass` ではなく `Bypass permissions` と書く
 */
export function launchedModeNote(replying: Replying | undefined, current: string | undefined): string {
  if (!replying || replying.failed || replying.via === 'terminal' || replying.permission_mode === undefined) return ''
  const launched = replying.permission_mode || 'default'
  const now = current || 'default'
  if (launched === now) return ''
  const name = (mode: string) => MODE_LABEL[mode as PermissionMode] ?? mode
  return `このターンは「${name(launched)}」で動いています。「${name(now)}」は次の返信から効きます`
}
