import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInline, parseMarkdown, stripMarkdown } from './markdown.ts'
import type { Block, Inline } from './markdown.ts'

// 木を短く書くための道具
const t = (text: string): Inline => ({ kind: 'text', text })
const c = (text: string): Inline => ({ kind: 'code', text })
const b = (...children: Inline[]): Inline => ({ kind: 'strong', children })
const a = (href: string, ...children: Inline[]): Inline => ({ kind: 'link', href, children: children.length ? children : [t(href)] })
const p = (...lines: Inline[][]): Block => ({ kind: 'paragraph', lines })

test('issue の例: 太字の中の URL がリンクになりアスタリスクが消える', () => {
  const src = 'PR を作成しました: **https://github.com/Naturalclar/sai/pull/6**'
  assert.deepEqual(parseMarkdown(src), [p([t('PR を作成しました: '), b(a('https://github.com/Naturalclar/sai/pull/6'))])])
})

test('むき出しの URL: 末尾の句読点と対応の無い閉じ括弧は含めない', () => {
  assert.deepEqual(parseInline('見て https://example.com/a. 次'), [t('見て '), a('https://example.com/a'), t('. 次')])
  assert.deepEqual(parseInline('(https://example.com/b)'), [t('('), a('https://example.com/b'), t(')')])
  assert.deepEqual(parseInline('https://en.wikipedia.org/wiki/Foo_(bar)'), [a('https://en.wikipedia.org/wiki/Foo_(bar)')])
  assert.deepEqual(parseInline('http://x.test/?q=1&r=2#f、次'), [a('http://x.test/?q=1&r=2#f'), t('、次')])
  assert.deepEqual(parseInline('（https://x.test/）を見て。'), [t('（'), a('https://x.test/'), t('）を見て。')])
})

test('[ラベル](URL) はリンク。http(s) 以外の先はリンクにしない', () => {
  assert.deepEqual(parseInline('[PR #6](https://github.com/Naturalclar/sai/pull/6) を見て'), [a('https://github.com/Naturalclar/sai/pull/6', t('PR #6')), t(' を見て')])
  assert.deepEqual(parseInline('[file](web/src/x.ts)'), [t('[file](web/src/x.ts)')])
  assert.deepEqual(parseInline('[x](javascript:alert(1))'), [t('[x](javascript:alert(1))')])
})

test('太字とコード。コードの中の ** は太字にしない', () => {
  assert.deepEqual(parseInline('**太字** と `a ** b` と **`code`**'), [b(t('太字')), t(' と '), c('a ** b'), t(' と '), b(c('code'))])
  // 空白で始まる・終わる ** や閉じの無い ** は素の文字
  assert.deepEqual(parseInline('** x ** と **y'), [t('** x ** と **y')])
})

test('HTML はただの文字', () => {
  assert.deepEqual(parseMarkdown('<script>alert(1)</script>'), [p([t('<script>alert(1)</script>')])])
})

test('箇条書き: 記号と深さ、記号なしの続き行は前の項目に付く', () => {
  const src = ['- a', '- **b**', '  - c', '    - d', '1. e', '2) f', '  続き'].join('\n')
  const blocks = parseMarkdown(src)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]!.kind, 'list')
  const items = blocks[0]!.kind === 'list' ? blocks[0]!.items : []
  assert.deepEqual(
    items.map((i) => [i.marker, i.depth]),
    [['-', 0], ['-', 0], ['-', 1], ['-', 1], ['1.', 0], ['2)', 0]],
  )
  assert.deepEqual(items[1]!.lines, [[b(t('b'))]])
  assert.deepEqual(items[5]!.lines, [[t('f')], [t('続き')]])
})

test('コードブロック: 中身は一切解釈しない。閉じが無ければ末尾まで', () => {
  const src = ['前', '```ts', 'const x = **1** // - not a list', '```', '後', '```', 'open'].join('\n')
  assert.deepEqual(parseMarkdown(src), [
    p([t('前')]),
    { kind: 'code', lang: 'ts', text: 'const x = **1** // - not a list' },
    p([t('後')]),
    { kind: 'code', lang: '', text: 'open' },
  ])
})

test('見出し・罫線・引用', () => {
  const src = ['# 見出し1', '### 見出し **3**', '---', '> 引用1', '> 引用2', '***'].join('\n')
  assert.deepEqual(parseMarkdown(src), [
    { kind: 'heading', level: 1, children: [t('見出し1')] },
    { kind: 'heading', level: 3, children: [t('見出し '), b(t('3'))] },
    { kind: 'rule' },
    { kind: 'quote', lines: [[t('引用1')], [t('引用2')]] },
    { kind: 'rule' },
  ])
})

test('段落: 続く行は1つの段落、空行で分かれる。行頭の空白は残す', () => {
  const src = ['1行目', '  2行目', '', '', '次の段落', '- 箇条書き', '', '段落'].join('\n')
  assert.deepEqual(parseMarkdown(src), [
    p([t('1行目')], [t('  2行目')]),
    p([t('次の段落')]),
    { kind: 'list', items: [{ depth: 0, marker: '-', lines: [[t('箇条書き')]] }] },
    p([t('段落')]),
  ])
})

test('CRLF と空文字', () => {
  assert.deepEqual(parseMarkdown('a\r\nb'), [p([t('a')], [t('b')])])
  assert.deepEqual(parseMarkdown(''), [])
  assert.deepEqual(parseMarkdown('\n\n'), [])
})

test('stripMarkdown: 一覧の1行表示から記号だけ落とす', () => {
  assert.equal(stripMarkdown('- **太字** と `code` と [ラベル](https://x.test/) と https://y.test/'), '太字 と code と ラベル と https://y.test/')
  assert.equal(stripMarkdown('## 見出し'), '見出し')
  assert.equal(stripMarkdown('> 引用'), '引用')
  assert.equal(stripMarkdown('1. 手順'), '手順')
  assert.equal(stripMarkdown('記号なし'), '記号なし')
})
