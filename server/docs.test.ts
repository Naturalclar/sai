// ドキュメントとコードのずれを見る。環境変数の表（README と CLAUDE.md）が、コードが実際に読む変数と揃っているか。
// 表が 2 つあるのでどちらか一方だけ更新される（#143）。ここで縛る
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * コードが読むけれど利用者が設定するものではない変数。表に載せない
 * - SAI_URL / SAI_ENTITY: runner.ts が --mcp-config の env で approve-mcp.ts に渡す内部用
 * - TMUX_PANE / CLAUDE_PID: エージェントが子（record.py）に渡してくる、居場所を知るための変数
 * - REPO_URL / PROD: Vite の import.meta.env（vite.config.ts の define と組み込み）
 */
const INTERNAL = new Set(['SAI_URL', 'SAI_ENTITY', 'TMUX_PANE', 'CLAUDE_PID', 'REPO_URL', 'PROD'])
/** 表にはあるけれどコードは読まない（フック設定例が使うだけ）。README / CLAUDE.md の説明がそう言っている */
const DOC_ONLY = new Set(['SAI_HOME'])

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

/** コードが読む環境変数。テストは除く（テストは env を偽物で渡すだけ） */
function envReadByCode(): Set<string> {
  const out = new Set<string>()
  const pattern = /(?:process\.env\.|\benv\.|os\.environ\.get\("|os\.environ\[")([A-Z][A-Z0-9_]{2,})/g
  for (const dir of ['server', 'shared', 'web/src', 'feed']) {
    for (const file of walk(join(ROOT, dir))) {
      if (!/\.(ts|tsx|py)$/.test(file) || /\.test\.ts$|test_.*\.py$/.test(file)) continue
      const src = readFileSync(file, 'utf-8')
      for (const m of src.matchAll(pattern)) if (!INTERNAL.has(m[1]!)) out.add(m[1]!)
    }
  }
  return out
}

/** ドキュメントの「## 環境変数」の表に出てくる `VAR`（1 行に複数書いてあってもよい） */
function envInTable(file: string): Set<string> {
  const text = readFileSync(join(ROOT, file), 'utf-8')
  const start = text.indexOf('\n## 環境変数')
  assert.ok(start >= 0, `${file} に「## 環境変数」の節が無い`)
  const rest = text.slice(start + 1)
  const end = rest.indexOf('\n## ', 1)
  const section = end >= 0 ? rest.slice(0, end) : rest
  const out = new Set<string>()
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `')) continue
    const cell = line.slice(1).split('|')[0] ?? ''
    for (const m of cell.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) out.add(m[1]!)
  }
  return out
}

test('環境変数: コードが読むものは README と CLAUDE.md の表の両方に載っている', () => {
  const code = envReadByCode()
  assert.ok(code.size >= 10, `コードから環境変数が拾えていない: ${[...code].join(', ')}`)
  for (const file of ['README.md', 'CLAUDE.md']) {
    const table = envInTable(file)
    const missing = [...code].filter((v) => !table.has(v)).sort()
    assert.deepEqual(missing, [], `${file} の環境変数の表に無い: ${missing.join(', ')}`)
  }
})

test('環境変数: 表にあるものはコードが読む（読まないものは DOC_ONLY に理由付きで）', () => {
  const code = envReadByCode()
  for (const file of ['README.md', 'CLAUDE.md']) {
    const stale = [...envInTable(file)].filter((v) => !code.has(v) && !DOC_ONLY.has(v)).sort()
    assert.deepEqual(stale, [], `${file} の表にあるがコードが読まない: ${stale.join(', ')}`)
  }
})
