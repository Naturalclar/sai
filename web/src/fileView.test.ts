import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FILE_LINE_H, fileLines, fileSizeLabel, initialMode, isMarkdownFile, lineNumbers, scrollTopFor, targetLine } from './fileView.ts'

test('initialMode: Markdown は描いた形、ほかは元の文字。行を指したら Markdown でも元の文字', () => {
  assert.equal(initialMode({ path: 'docs/screen.md', line: 0 }), 'rendered')
  assert.equal(initialMode({ path: 'docs/screen.md', line: 12 }), 'raw')
  assert.equal(initialMode({ path: 'server/app.ts', line: 0 }), 'raw')
  assert.equal(initialMode({ path: 'page.html', line: 0 }), 'raw', 'HTML は描かない')
  assert.equal(isMarkdownFile('README.MD'), true)
  assert.equal(isMarkdownFile('notes.mdx'), true)
  assert.equal(isMarkdownFile('md.ts'), false)
})

test('fileLines / lineNumbers: 最後の改行のあとは数えない。空のファイルは 1 行', () => {
  assert.deepEqual(fileLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(fileLines('a\r\nb'), ['a', 'b'])
  assert.deepEqual(fileLines('a\n\n'), ['a', ''])
  assert.deepEqual(fileLines(''), [''])
  assert.equal(lineNumbers(3), '1\n2\n3')
  assert.equal(lineNumbers(1), '1')
})

test('targetLine / scrollTopFor: path:行 の飛び先。範囲の外は飛ばない', () => {
  assert.equal(targetLine(12, 40), 12)
  assert.equal(targetLine(41, 40), 0)
  assert.equal(targetLine(0, 40), 0)
  assert.equal(scrollTopFor(1, 600), 0)
  assert.equal(scrollTopFor(101, 600), 100 * FILE_LINE_H - 200)
})

test('fileSizeLabel', () => {
  assert.equal(fileSizeLabel(300), '300B')
  assert.equal(fileSizeLabel(12 * 1024), '12KB')
  assert.equal(fileSizeLabel(1.2 * 1024 * 1024), '1.2MB')
})
