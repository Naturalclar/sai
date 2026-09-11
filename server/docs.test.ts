// ドキュメントとコードのずれを見る。環境変数の表（README と CLAUDE.md）が、コードが実際に読む変数と揃っているか。
// 表が 2 つあるのでどちらか一方だけ更新される（#143）。ここで縛る
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * コードが読むけれど利用者が設定するものではない変数。表に載せない（README の表の下に一言で書く）
 * - SAI_URL / SAI_ENTITY / SAI_TOKEN_FILE: runner.ts が --mcp-config の env で approve-mcp.ts に渡す内部用（SAI_TOKEN_FILE は #310）
 * - AGENT_FEED_SKIP: SAI が一言を作る `claude -p` に自分で付ける合図（record.py / statusline.py / OpenCode のプラグインが見る。#288）
 * - TMUX_PANE / CLAUDE_PID: エージェントが子（record.py）に渡してくる、居場所を知るための変数
 * - REPO_URL / PROD: Vite の import.meta.env（vite.config.ts の define と組み込み）
 */
const INTERNAL = new Set(['SAI_URL', 'SAI_ENTITY', 'SAI_TOKEN_FILE', 'AGENT_FEED_SKIP', 'TMUX_PANE', 'CLAUDE_PID', 'REPO_URL', 'PROD'])

/** 「## 環境変数」の中の 2 つの表の見出し（#288）。区別の無い 1 枚の表だと、全部設定しないと動かないように見える */
const SUBSECTIONS = ['### 設定することがあるもの', '### 切り分け・内部']

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

/**
 * コードが読む環境変数。テストは除く（テストは env を偽物で渡すだけ）。
 * **`.js` も見る**: OpenCode のプラグイン（`feed/opencode/sai.js`）は JavaScript で、見ていなかった頃は
 * そこが読む `SAI_HOME` を「コードは読まない」と書いたままになっていた（#288）
 */
function envReadByCode(): Set<string> {
  const out = new Set<string>()
  const pattern = /(?:process\.env\.|\benv\.|os\.environ\.get\("|os\.environ\[")([A-Z][A-Z0-9_]{2,})/g
  for (const dir of ['server', 'shared', 'web/src', 'feed']) {
    for (const file of walk(join(ROOT, dir))) {
      if (!/\.(ts|tsx|js|mjs|py)$/.test(file) || /\.test\.ts$|test_.*\.py$/.test(file)) continue
      const src = readFileSync(file, 'utf-8')
      for (const m of src.matchAll(pattern)) if (!INTERNAL.has(m[1]!)) out.add(m[1]!)
    }
  }
  return out
}

/** ドキュメントの「## 環境変数」の節（次の `## ` の手前まで。`###` の小見出しは中に含む） */
function envSection(file: string): string {
  const text = readFileSync(join(ROOT, file), 'utf-8')
  const start = text.indexOf('\n## 環境変数')
  assert.ok(start >= 0, `${file} に「## 環境変数」の節が無い`)
  const rest = text.slice(start + 1)
  const end = rest.indexOf('\n## ', 1)
  return end >= 0 ? rest.slice(0, end) : rest
}

/** 表の行ごとの `VAR`（1 行に複数書いてあってもよい） */
function envRows(file: string): string[][] {
  const rows: string[][] = []
  for (const line of envSection(file).split('\n')) {
    if (!line.startsWith('| `')) continue
    const cell = line.slice(1).split('|')[0] ?? ''
    rows.push([...cell.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]!))
  }
  return rows
}

const envInTable = (file: string): Set<string> => new Set(envRows(file).flat())

test('環境変数: コードが読むものは README と CLAUDE.md の表の両方に載っている', () => {
  const code = envReadByCode()
  assert.ok(code.size >= 10, `コードから環境変数が拾えていない: ${[...code].join(', ')}`)
  for (const file of ['README.md', 'CLAUDE.md']) {
    const table = envInTable(file)
    const missing = [...code].filter((v) => !table.has(v)).sort()
    assert.deepEqual(missing, [], `${file} の環境変数の表に無い: ${missing.join(', ')}`)
  }
})

test('環境変数: 表にあるものはコードが読む', () => {
  const code = envReadByCode()
  for (const file of ['README.md', 'CLAUDE.md']) {
    const stale = [...envInTable(file)].filter((v) => !code.has(v)).sort()
    assert.deepEqual(stale, [], `${file} の表にあるがコードが読まない: ${stale.join(', ')}`)
  }
})

test('環境変数: 表は「設定することがあるもの」と「切り分け・内部」に分け、同じ変数を 2 回載せない（#288）', () => {
  for (const file of ['README.md', 'CLAUDE.md']) {
    const section = envSection(file)
    for (const heading of SUBSECTIONS) assert.ok(section.includes(`\n${heading}\n`), `${file} の環境変数の節に「${heading}」が無い`)
    const seen = new Map<string, number>()
    for (const name of envRows(file).flat()) seen.set(name, (seen.get(name) ?? 0) + 1)
    const twice = [...seen].filter(([, n]) => n > 1).map(([name]) => name)
    assert.deepEqual(twice, [], `${file} の表に 2 回ある: ${twice.join(', ')}`)
  }
})
