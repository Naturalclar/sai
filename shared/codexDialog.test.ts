import assert from 'node:assert/strict'
import test from 'node:test'
import { CODEX_DIALOG_TEXT, codexDialogKey, codexDialogText, parseCodexDialog } from './codexDialog.ts'

/** 実機の画面（codex 0.154.0。tmux capture-pane -p。要素の間に空行が入る） */
const COMMAND_SCREEN = [
  '› マージして',
  '',
  '',
  '• 了解です。dev-chiki の実装をコミットし、最新の origin/main を取り込んで検証後、ローカル main をマージ済みコミットへ進めます。',
  '',
  '• Running git add -A',
  '',
  '⚠ The linear MCP server requires OAuth reauthentication. Run `codex mcp login linear`.',
  '',
  '⚠ MCP startup incomplete (failed: linear)',
  '',
  '  Would you like to run the following command?',
  '',
  '  Environment: local',
  '',
  '  Reason: この worktree の変更をコミットするため、共有 Git メタデータへの書き込みを許可しますか？',
  '',
  '  $ git add -A',
  '',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for commands that start with `git add` (p)",
  '  3. No, and tell Codex what to do differently (esc)',
  '',
  '  Press enter to confirm or esc to cancel',
].join('\n')

test('許可のダイアログを、見出し・理由・コマンド・選択肢に分ける（#425）', () => {
  const dialog = parseCodexDialog(COMMAND_SCREEN)
  assert.ok(dialog)
  assert.equal(dialog.title, 'Would you like to run the following command?')
  assert.equal(dialog.detail, 'Environment: local\nReason: この worktree の変更をコミットするため、共有 Git メタデータへの書き込みを許可しますか？')
  assert.equal(dialog.command, 'git add -A')
  assert.deepEqual(dialog.options, [
    { number: 1, label: 'Yes, proceed (y)', selected: true },
    { number: 2, label: "Yes, and don't ask again for commands that start with `git add` (p)", selected: false },
    { number: 3, label: 'No, and tell Codex what to do differently (esc)', selected: false },
  ])
})

test('会話の行は混ぜない（字下げの無い行で止める。人の入力欄も境目）', () => {
  const dialog = parseCodexDialog(COMMAND_SCREEN)!
  const all = [dialog.title, dialog.detail, dialog.command, ...dialog.options.map((o) => o.label)].join('\n')
  assert.ok(!all.includes('MCP startup incomplete'), '⚠ の行が入っている')
  assert.ok(!all.includes('マージして'), '人の入力欄が入っている')
})

test('複数行のコマンドはそのまま（`$` の下の続きも拾う）。頭が画面から切れていれば見出しは空', () => {
  const screen = [
    '  $ gh pr create --base main --title "docs: remove metadata" --body "## Summary',
    '  - remove incidental calendar dates',
    '  - retain benchmark conditions"',
    '',
    '› 1. Yes, proceed (y)',
    '  2. No, and tell Codex what to do differently (esc)',
    '',
    '  Press enter to confirm or esc to cancel',
  ].join('\n')
  const dialog = parseCodexDialog(screen)!
  assert.equal(dialog.title, '')
  assert.equal(dialog.command, 'gh pr create --base main --title "docs: remove metadata" --body "## Summary\n- remove incidental calendar dates\n- retain benchmark conditions"')
  assert.equal(dialog.options.length, 2)
})

test('選択肢が画面の幅で折り返されていれば、続きを 1 つの選択肢にまとめる', () => {
  const screen = [
    '  Would you like to run the following command?',
    "› 1. Yes, and don't ask again for commands that start with",
    '  `gh pr create` (p)',
    '  2. No (esc)',
    '  Press enter to confirm or esc to cancel',
  ].join('\n')
  const dialog = parseCodexDialog(screen)!
  assert.deepEqual(dialog.options, [
    { number: 1, label: "Yes, and don't ask again for commands that start with `gh pr create` (p)", selected: true },
    { number: 2, label: 'No (esc)', selected: false },
  ])
})

test('コマンドのない質問のダイアログ（見出しと選択肢だけ）', () => {
  const screen = [
    '  どのブランチから始めますか？',
    '',
    '› 1. main',
    '  2. dev-min',
    '',
    '  Press enter to confirm or esc to cancel',
  ].join('\n')
  const dialog = parseCodexDialog(screen)!
  assert.equal(dialog.command, '')
  assert.equal(dialog.title, 'どのブランチから始めますか？')
  assert.equal(codexDialogText(dialog), 'Codex の質問: どのブランチから始めますか？')
})

test('選択肢が読めない画面は null（今までどおりの 1 行に落ちる）', () => {
  // 信頼の確認のように、番号付きの選択肢が無いダイアログ
  assert.equal(parseCodexDialog('  Do you trust the files in this folder?\n\n  Press enter to continue'), null)
  assert.equal(parseCodexDialog('› \n  Ask Codex to do anything'), null)
  assert.equal(codexDialogText(null), CODEX_DIALOG_TEXT)
})

test('一覧に出す 1 行は、許可ならコマンドそのもの', () => {
  assert.equal(codexDialogText(parseCodexDialog(COMMAND_SCREEN)), 'Codex の許可待ち: git add -A')
})

test('鍵はカーソルの位置では変わらない（矢印で選び直しても待ち始めた時刻を戻さない）', () => {
  const moved = COMMAND_SCREEN.replace('› 1. Yes, proceed (y)', '  1. Yes, proceed (y)').replace("  2. Yes, and don't", "› 2. Yes, and don't")
  const before = parseCodexDialog(COMMAND_SCREEN)
  const after = parseCodexDialog(moved)
  assert.equal(after!.options[1]!.selected, true, 'カーソルは移っている')
  assert.equal(codexDialogKey(before), codexDialogKey(after))
  // 別の許可に変われば鍵も変わる
  assert.notEqual(codexDialogKey(before), codexDialogKey(parseCodexDialog(COMMAND_SCREEN.replace('$ git add -A', '$ git commit'))))
})

test('会話の引用の枠（`│` / `└`）で遡るのを止める（字下げがダイアログと同じ）', () => {
  // 実機（prism-river の `gh pr create`）。枠で止めないと見出しが `│` になり、理由が説明に押し出される
  const screen = [
    '• Ran gh pr create --base main --title "docs: remove incidental metadata"',
    '  │',
    '  │ - remove incidental calendar dates from README benchmarks',
    '  │ … +8 lines',
    '  └ error connecting to api.github.com',
    '',
    '  Would you like to run the following command?',
    '',
    '  Environment: local',
    '',
    '  Reason: Allow GitHub CLI network access to create the requested pull request?',
    '',
    '  $ gh pr create --base main --title "docs: remove incidental metadata"',
    '',
    '› 1. Yes, proceed (y)',
    '  2. No, and tell Codex what to do differently (esc)',
    '',
    '  Press enter to confirm or esc to cancel',
  ].join('\n')
  const dialog = parseCodexDialog(screen)!
  assert.equal(dialog.title, 'Would you like to run the following command?')
  assert.equal(dialog.detail, 'Environment: local\nReason: Allow GitHub CLI network access to create the requested pull request?')
  assert.ok(!dialog.detail.includes('+8 lines'), '会話の引用が入っている')
})
