import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PASTE_FILE_MIN_CHARS, PASTE_PREVIEW_CHARS, pasteBecomesFile, pasteChars, pasteLabel, pastePreview, restorePaste } from './pasteFile.ts'

test('pasteBecomesFile: 設定が入で、しきい値を超えた貼り付けだけ（#609）', () => {
  const at = 'あ'.repeat(PASTE_FILE_MIN_CHARS)
  assert.equal(pasteBecomesFile(at, true), false, 'しきい値ちょうどは本文のまま')
  assert.equal(pasteBecomesFile(`${at}あ`, true), true)
  assert.equal(pasteBecomesFile(`${at}あ`, false), false, '既定は切')
  assert.equal(pasteBecomesFile('\n'.repeat(PASTE_FILE_MIN_CHARS + 1), true), true, '改行だけでも長ければファイル')
  // 絵文字はサロゲートペア（UTF-16 では 2）。字数で数える
  assert.equal(pasteBecomesFile('😀'.repeat(PASTE_FILE_MIN_CHARS), true), false)
  assert.equal(pasteBecomesFile('😀'.repeat(PASTE_FILE_MIN_CHARS + 1), true), true)
  assert.equal(pasteBecomesFile('', true), false)
})

test('pasteChars / pasteLabel / restorePaste / pastePreview', () => {
  assert.equal(pasteChars('a😀あ\n'), 4)
  assert.equal(pasteLabel(12340), '貼り付けた文（12,340 字）')
  assert.equal(restorePaste('', 'ログ'), 'ログ')
  assert.equal(restorePaste('  \n', 'ログ'), 'ログ')
  assert.equal(restorePaste('これ見て\n', 'ログ'), 'これ見て\nログ')
  assert.deepEqual(pastePreview('短い'), { head: '短い', rest: 0 })
  const long = pastePreview('😀'.repeat(PASTE_PREVIEW_CHARS + 5))
  assert.deepEqual([Array.from(long.head).length, long.rest], [PASTE_PREVIEW_CHARS, 5])
})
