import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdown } from '../../shared/markdown.ts'
import { codeCopyText, codeCopyView } from './codeCopy.ts'

test('codeCopyText: 言語名と前後の ``` を含めず、描いた block.text そのまま', () => {
  const blocks = parseMarkdown('前の文\n\n```sh\npnpm install\n  pnpm start --port 9000\n```\n\n後の文')
  const code = blocks.find((b) => b.kind === 'code')
  assert.ok(code && code.kind === 'code')
  assert.equal(codeCopyText(code), 'pnpm install\n  pnpm start --port 9000')
  assert.equal(codeCopyText(code), code.text)
})

test('codeCopyText: HTML の文字もそのまま（逃がさない・足さない）', () => {
  const blocks = parseMarkdown('```\n<a href="x">&amp;</a>\n```')
  const code = blocks[0]
  assert.ok(code?.kind === 'code')
  assert.equal(codeCopyText(code), '<a href="x">&amp;</a>')
})

test('codeCopyView: 書けなかったときだけ案内を出す', () => {
  assert.deepEqual(codeCopyView('idle'), { label: 'コードをコピー', note: '' })
  assert.deepEqual(codeCopyView('copied'), { label: 'コピーしました', note: '' })
  assert.equal(codeCopyView('failed').label, 'コードをコピー')
  assert.equal(codeCopyView('failed').note, 'コピーできません（選んでコピーしてください）')
})
