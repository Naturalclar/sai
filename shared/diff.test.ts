import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareUrl, parseUnifiedDiff, SKIPPED_MARK } from './diff.ts'

const PATCH = [
  'diff --git a/server/app.ts b/server/app.ts',
  'index 1111111..2222222 100644',
  '--- a/server/app.ts',
  '+++ b/server/app.ts',
  '@@ -10,3 +10,4 @@ export function createApp() {',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' const d = 5',
].join('\n')

test('parseUnifiedDiff: ハンクの行と行番号', () => {
  const [f] = parseUnifiedDiff(PATCH)
  assert.equal(f?.path, 'server/app.ts')
  assert.equal(f?.status, 'modified')
  assert.equal(f?.hunks.length, 1)
  assert.equal(f?.hunks[0]?.header, '@@ -10,3 +10,4 @@ export function createApp() {')
  assert.deepEqual(
    f?.hunks[0]?.lines.map((l) => [l.kind, l.text, l.oldNo, l.newNo]),
    [
      ['ctx', 'const a = 1', 10, 10],
      ['del', 'const b = 2', 11, 0],
      ['add', 'const b = 3', 0, 11],
      ['add', 'const c = 4', 0, 12],
      ['ctx', 'const d = 5', 12, 13],
    ],
  )
})

test('parseUnifiedDiff: 追加・削除・リネーム・バイナリ・落としたファイル', () => {
  const patch = [
    'diff --git a/new.ts b/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-bye',
    'diff --git a/old.ts b/moved.ts',
    'similarity index 90%',
    'rename from old.ts',
    'rename to moved.ts',
    'diff --git a/logo.png b/logo.png',
    'index 3333333..4444444 100644',
    'Binary files a/logo.png and b/logo.png differ',
    'diff --git a/huge.json b/huge.json',
    SKIPPED_MARK,
  ].join('\n')
  const files = parseUnifiedDiff(patch)
  assert.deepEqual(
    files.map((f) => [f.path, f.oldPath, f.status, f.binary, f.skipped]),
    [
      ['new.ts', '', 'added', false, false],
      ['gone.ts', 'gone.ts', 'deleted', false, false],
      ['moved.ts', 'old.ts', 'renamed', false, false],
      ['logo.png', 'logo.png', 'modified', true, false],
      ['huge.json', 'huge.json', 'modified', false, true],
    ],
  )
  assert.equal(files[0]?.hunks[0]?.lines.length, 2)
  assert.equal(files[3]?.hunks.length, 0, 'バイナリにハンクは無い')
})

test('parseUnifiedDiff: 空・壊れた出力でも落ちない', () => {
  assert.deepEqual(parseUnifiedDiff(''), [])
  assert.deepEqual(parseUnifiedDiff('とつぜんの文\n@@ -1 +1 @@\n+x'), [], 'diff --git の外は捨てる')
  const q = parseUnifiedDiff('diff --git "a/名 前.ts" "b/名 前.ts"\n--- "a/名 前.ts"\n+++ "b/名 前.ts"\n@@ -1 +1 @@\n-a\n+b')
  assert.equal(q[0]?.path, '名 前.ts', '引用符付きのパス')
})

test('compareUrl', () => {
  assert.equal(
    compareUrl('https://github.com/Naturalclar/sai', 'origin/main', 'dev-min'),
    'https://github.com/Naturalclar/sai/compare/main...dev-min',
  )
  assert.equal(compareUrl('https://github.com/Naturalclar/sai/', 'main', 'feat/x'), 'https://github.com/Naturalclar/sai/compare/main...feat%2Fx')
  assert.equal(compareUrl('', 'main', 'x'), '')
  assert.equal(compareUrl(undefined, 'main', 'x'), '')
  assert.equal(compareUrl('https://github.com/o/r', '', 'x'), '')
  assert.equal(compareUrl('https://github.com/o/r', 'main', ''), '')
})
