// セッションの cwd から、いま効いている許可ルールを読む。**読むだけ**で、書き換えは「常に許可」の経路（app.ts）だけ。
//
// Claude Code の設定は重なる。強い順に managed > コマンドライン（--settings）> ローカル > プロジェクト > ユーザー。
// ただしルールの評価は種類が先で、deny → ask → allow の順に見て最初に当たったものが決まる。
// deny は**どのスコープのものでも** allow に勝つ（公式ドキュメント「Manage permissions」）。
// なので画面には「出どころの階段」ではなく「deny → ask → allow」の順に、各ルールの出どころを添えて出す。
//
// コマンドライン（`claude --settings`）は端末側の起動引数なので SAI からは分からない。読まない。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { splitArgs } from './runner.ts'
import type { PermissionKind, PermissionRuleEntry, PermissionSource, PermissionSourceKind } from '../shared/types.ts'
import { PERMISSION_KINDS, SOURCE_ORDER } from '../shared/permissions.ts'

/** 設定ファイルの読み込み上限。普通は数 KB で、これを超えるものは読まない */
export const MAX_SETTINGS_BYTES = 512 * 1024

/** managed settings の置き場（OS ごとに固定）。組織が配る分で、個人の設定では上書きできない */
export function managedSettingsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
  return '/etc/claude-code/managed-settings.json'
}

/**
 * 読む先。強い順（managed > ローカル > プロジェクト > ユーザー）。
 * **固定パスしか組み立てない**（cwd は集計が持っているものだけ。リクエストからパスを受け取らない）
 */
export function settingsPaths(cwd: string, home: string, platform: NodeJS.Platform = process.platform): { kind: PermissionSourceKind; path: string }[] {
  return [
    { kind: 'managed', path: managedSettingsPath(platform) },
    { kind: 'local', path: join(cwd, '.claude', 'settings.local.json') },
    { kind: 'project', path: join(cwd, '.claude', 'settings.json') },
    { kind: 'user', path: join(home, '.claude', 'settings.json') },
  ]
}

/** 文字列の配列だけ取る（他の型が混ざっていても落とさない） */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []
}

/** 設定ファイル 1 つ分の permissions。読めなければ missing / broken を立てて空で返す */
export function parseSettings(kind: PermissionSourceKind, path: string, raw: string | null): { source: PermissionSource; rules: PermissionRuleEntry[] } {
  if (raw === null) return { source: { kind, path, missing: true }, rules: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { source: { kind, path, broken: true }, rules: [] }
  }
  const permissions = (parsed as { permissions?: unknown } | null)?.permissions
  if (!permissions || typeof permissions !== 'object') return { source: { kind, path }, rules: [] }
  const p = permissions as Record<string, unknown>
  const source: PermissionSource = { kind, path }
  if (typeof p.defaultMode === 'string' && p.defaultMode) source.default_mode = p.defaultMode
  const rules: PermissionRuleEntry[] = []
  for (const permission of PERMISSION_KINDS) {
    for (const rule of stringList(p[permission])) rules.push({ kind: permission, rule, source: kind })
  }
  return { source, rules }
}

/**
 * SAI_CLAUDE_ARGS の `--allowedTools` / `--disallowedTools`。SAI から返信したターンにだけ効く（端末のターンには効かない）。
 * どちらも可変長なので、次のフラグ（`-` 始まり）まで拾う
 */
export function argsRules(raw: string | undefined): { source: PermissionSource; rules: PermissionRuleEntry[] } {
  const args = splitArgs(raw)
  const source: PermissionSource = { kind: 'sai_args', path: 'SAI_CLAUDE_ARGS' }
  if (args.length === 0) return { source: { ...source, missing: true }, rules: [] }
  const rules: PermissionRuleEntry[] = []
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!
    const kind: PermissionKind | null = flag === '--allowedTools' ? 'allow' : flag === '--disallowedTools' ? 'deny' : null
    if (!kind) continue
    for (let j = i + 1; j < args.length && !args[j]!.startsWith('-'); j++) {
      rules.push({ kind, rule: args[j]!, source: 'sai_args' })
      i = j
    }
  }
  return { source, rules }
}

/** deny → ask → allow の順に、同じ種類の中は強い出どころから並べる（評価の順そのもの） */
export function orderRules(rules: PermissionRuleEntry[]): PermissionRuleEntry[] {
  return [...rules].sort((a, b) => {
    const byKind = PERMISSION_KINDS.indexOf(a.kind) - PERMISSION_KINDS.indexOf(b.kind)
    if (byKind !== 0) return byKind
    const bySource = SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)
    if (bySource !== 0) return bySource
    return a.rule.localeCompare(b.rule)
  })
}

/** ファイルを読む口。テストでは差し替える */
export type ReadSettings = (path: string) => Promise<string | null>

/** 実際に読む。無い・大きすぎる・読めないは null（missing 扱い。落とさない） */
export const readSettingsFile: ReadSettings = async (path) => {
  try {
    const raw = await readFile(path, 'utf-8')
    return raw.length > MAX_SETTINGS_BYTES ? null : raw
  } catch {
    return null
  }
}

/** その cwd に効いている許可ルールと、読んだファイルの一覧 */
export async function collectPermissions(
  cwd: string,
  options: { home: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; read?: ReadSettings } ,
): Promise<{ sources: PermissionSource[]; rules: PermissionRuleEntry[] }> {
  const read = options.read ?? readSettingsFile
  const env = options.env ?? process.env
  const files = settingsPaths(cwd, options.home, options.platform)
  const sources: PermissionSource[] = []
  const rules: PermissionRuleEntry[] = []
  for (const file of files) {
    const parsed = parseSettings(file.kind, file.path, await read(file.path))
    sources.push(parsed.source)
    rules.push(...parsed.rules)
  }
  const fromArgs = argsRules(env.SAI_CLAUDE_ARGS)
  sources.push(fromArgs.source)
  rules.push(...fromArgs.rules)
  return { sources, rules: orderRules(rules) }
}
