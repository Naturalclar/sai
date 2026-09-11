import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInline, parseMarkdown, stripMarkdown } from './markdown.ts'
import type { Block, Inline, TableAlign } from './markdown.ts'

// 木を短く書くための道具
const t = (text: string): Inline => ({ kind: 'text', text })
const c = (text: string): Inline => ({ kind: 'code', text })
const b = (...children: Inline[]): Inline => ({ kind: 'strong', children })
const a = (href: string, ...children: Inline[]): Inline => ({ kind: 'link', href, children: children.length ? children : [t(href)] })
const p = (...lines: Inline[][]): Block => ({ kind: 'paragraph', lines })
const e = (name: string, char: string): Inline => ({ kind: 'emoji', name, char })

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

const table = (align: TableAlign[], head: Inline[][], rows: Inline[][][]): Block => ({ kind: 'table', align, head, rows })

test('表（#328）: 見出し + 区切り + 本文。セルの中も行内の解析が効き、前後の段落はそのまま', () => {
  const src = ['変えたファイル:', '', '| ファイル | 何を変えたか |', '| --- | --- |', '| `shared/markdown.ts` | 表を **table** にする |', '| `web/src/BlockView.tsx` | — |', '', '以上。'].join('\n')
  assert.deepEqual(parseMarkdown(src), [
    p([t('変えたファイル:')]),
    table(
      [null, null],
      [[t('ファイル')], [t('何を変えたか')]],
      [
        [[c('shared/markdown.ts')], [t('表を '), b(t('table')), t(' にする')]],
        [[c('web/src/BlockView.tsx')], [t('—')]],
      ],
    ),
    p([t('以上。')]),
  ])
})

test('表: 揃えは区切りの行の : の位置。外側の | が無くても読む', () => {
  const [tb] = parseMarkdown(['a | b | c | d', ':--- | :---: | ---: | ---', '1 | 2 | 3 | 4'].join('\n'))
  assert.deepEqual(tb, table(['left', 'center', 'right', null], [[t('a')], [t('b')], [t('c')], [t('d')]], [[[t('1')], [t('2')], [t('3')], [t('4')]]]))
})

test('表: \\| はセルを分けずに | に戻る（コードの中も）', () => {
  const [tb] = parseMarkdown(['| 式 | 意味 |', '| --- | --- |', '| `a \\| b` | a または b |'].join('\n'))
  assert.deepEqual(tb, table([null, null], [[t('式')], [t('意味')]], [[[c('a | b')], [t('a または b')]]]))
})

test('表: 列の足りない行は空のセルで埋め、多い行は切る', () => {
  const [tb] = parseMarkdown(['| a | b |', '| --- | --- |', '| 1 |', '| 1 | 2 | 3 |'].join('\n'))
  assert.deepEqual(tb, table([null, null], [[t('a')], [t('b')]], [[[t('1')], []], [[t('1')], [t('2')]]]))
})

test('表にならないもの: 区切りの列数が違う・区切りが無い・コードブロックの中・| の無い ---', () => {
  assert.deepEqual(parseMarkdown(['| a | b |', '| --- |', '| 1 | 2 |'].join('\n')), [p([t('| a | b |')], [t('| --- |')], [t('| 1 | 2 |')])])
  assert.deepEqual(parseMarkdown('A か B | C のどちらか\n次の行'), [p([t('A か B | C のどちらか')], [t('次の行')])])
  assert.deepEqual(parseMarkdown(['```', '| a | b |', '| --- | --- |', '```'].join('\n')), [{ kind: 'code', lang: '', text: '| a | b |\n| --- | --- |' }])
  // | の無い --- は罫線（表の区切りにしない）
  assert.deepEqual(parseMarkdown('a | b\n\n---'), [p([t('a | b')]), { kind: 'rule' }])
})

test('表: 段落の直後の行からでも始まり、| の無い行・空行・見出しで終わる', () => {
  const src = ['まとめ:', '| a | b |', '| --- | --- |', '| 1 | 2 |', 'おわり', '', '| x |', '| --- |', '| 9 |', '## 次'].join('\n')
  assert.deepEqual(parseMarkdown(src), [
    p([t('まとめ:')]),
    table([null, null], [[t('a')], [t('b')]], [[[t('1')], [t('2')]]]),
    p([t('おわり')]),
    table([null], [[t('x')]], [[[t('9')]]]),
    { kind: 'heading', level: 2, children: [t('次')] },
  ])
})

test('箇条書き: 記号と深さ、記号なしの続き行は前の項目に付く', () => {
  const src = ['- a', '- **b**', '  - c', '    - d', '1. e', '2) f', '  続き'].join('\n')
  const blocks = parseMarkdown(src)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]!.kind, 'list')
  const items = blocks[0]!.kind === 'list' ? blocks[0]!.items : []
  assert.deepEqual(
    items.map((i) => [i.marker, i.depth]),
    [['-', 0], ['-', 0], ['-', 1], ['-', 2], ['1.', 0], ['2)', 0]],
  )
  assert.deepEqual(items[1]!.lines, [[b(t('b'))]])
  assert.deepEqual(items[5]!.lines, [[t('f')], [t('続き')]])
})

test('箇条書きの深さ: 2 スペースで 1 段。番号付きの下の 3 スペースも 1 段、タブは 2 スペース扱い、5 段で頭打ち', () => {
  const depths = (src: string) => {
    const block = parseMarkdown(src)[0]!
    return block.kind === 'list' ? block.items.map((i) => i.depth) : []
  }
  // #60: 4 スペースの 3 段目が 2 段目と同じ深さになっていた
  assert.deepEqual(depths(['- a', '  - b', '    - c', '      - d'].join('\n')), [0, 1, 2, 3])
  assert.deepEqual(depths(['1. a', '   - b', '   1. c'].join('\n')), [0, 1, 1])
  assert.deepEqual(depths(['- a', '\t- b', '\t\t- c'].join('\n')), [0, 1, 2])
  assert.deepEqual(depths(['- a', ' - b', '   - c'].join('\n')), [0, 0, 1])
  assert.deepEqual(depths(['- a', '            - b'].join('\n')), [0, 5])
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

const img = (src: string, alt: string): Inline => ({ kind: 'image', src, alt })

test('画像（#321）: ![alt](パス) と、画像の拡張子の [名前](パス) は画像のノード。Codex は後者の形で出す', () => {
  const path = '/Users/me/sai.git/dev-codex/docs/assets/codex-agent-icon.png'
  assert.deepEqual(parseInline(`Codex用アイコン作成！[codex-agent-icon.png](${path}) 1254×1254px透過PNG。`), [
    t('Codex用アイコン作成！'),
    img(path, 'codex-agent-icon.png'),
    t(' 1254×1254px透過PNG。'),
  ])
  assert.deepEqual(parseInline('![スクショ](./shots/a.PNG)'), [img('./shots/a.PNG', 'スクショ')], '拡張子の大文字小文字は問わない')
  assert.deepEqual(parseInline('![](docs/x.webp)'), [img('docs/x.webp', '')])
  assert.deepEqual(parseInline('[図](a/b.jpeg) と [図2](c.gif)'), [img('a/b.jpeg', '図'), t(' と '), img('c.gif', '図2')])
  assert.deepEqual(parseInline('**[a](x.png)**'), [b(img('x.png', 'a'))])
  assert.deepEqual(parseMarkdown(`- ${path}\n- [icon](${path})`), [
    { kind: 'list', items: [
      { depth: 0, marker: '-', lines: [[t(path)]] },
      { depth: 0, marker: '-', lines: [[img(path, 'icon')]] },
    ] },
  ], 'むき出しのパスは今までどおり文字')
})

test('画像: 外の URL の画像は読み込まないのでリンク。画像でないパス・スキーム付き・コードの中は文字のまま', () => {
  assert.deepEqual(parseInline('![図](https://x.test/a.png)'), [a('https://x.test/a.png', t('図'))])
  assert.deepEqual(parseInline('![](https://x.test/a.png)'), [a('https://x.test/a.png')])
  assert.deepEqual(parseInline('[a.png](https://x.test/a.png)'), [a('https://x.test/a.png', t('a.png'))])
  assert.deepEqual(parseInline('[file](web/src/x.ts)'), [t('[file](web/src/x.ts)')])
  assert.deepEqual(parseInline('前 ![x](notes.txt) 後'), [t('前 ![x](notes.txt) 後')])
  assert.deepEqual(parseInline('[x](file:///a.png)'), [t('[x](file:///a.png)')])
  assert.deepEqual(parseInline('![x](javascript:a.png)'), [t('![x](javascript:a.png)')])
  assert.deepEqual(parseInline('[x](data:image/png;base64,AAAA.png)'), [t('[x](data:image/png;base64,AAAA.png)')])
  assert.deepEqual(parseInline('`![x](a.png)`'), [c('![x](a.png)')])
})

test('stripMarkdown: 画像は名前（無ければファイル名）だけ残す', () => {
  assert.equal(stripMarkdown('アイコン [icon.png](/a/b/icon.png) できた'), 'アイコン icon.png できた')
  assert.equal(stripMarkdown('![](/a/b/shot.png)'), 'shot.png')
})

test('絵文字: 表にある `:name:` だけ絵文字にする', () => {
  assert.deepEqual(parseInline('やった:tada:'), [t('やった'), e('tada', '🎉')])
  assert.deepEqual(parseInline(':+1: と :100:'), [e('+1', '👍'), t(' と '), e('100', '💯')])
  assert.deepEqual(parseInline('**:tada:**'), [b(e('tada', '🎉'))], '太字の中でも効く')
})

test('絵文字: 表に無い名前・コード・時刻はそのまま', () => {
  assert.deepEqual(parseInline(':nosuchname:'), [t(':nosuchname:')], '表に無ければただの文字')
  assert.deepEqual(parseInline(':foo::tada:'), [t(':foo:'), e('tada', '🎉')], '表に無い名前の後ろも探す')
  assert.deepEqual(parseInline('14:08:30 に終わった'), [t('14:08:30 に終わった')], '時刻は絵文字にしない')
  assert.deepEqual(parseInline('PATH=a:b:c'), [t('PATH=a:b:c')])
  assert.deepEqual(parseInline('`:tada:`'), [c(':tada:')], 'コードの中は解釈しない')
  assert.deepEqual(parseMarkdown('```\n:tada:\n```'), [{ kind: 'code', lang: '', text: ':tada:' }], 'コードブロックの中も')
  // URL が先に当たる（左から一番早い）。末尾の `:` は前からある trimUrl が URL から外すので、そこだけ文字として残る
  assert.deepEqual(parseInline('https://x.test/a:tada:'), [a('https://x.test/a:tada'), t(':')], 'URL の中は絵文字にしない')
})

test('絵文字: stripMarkdown では絵文字の文字だけ残す', () => {
  assert.equal(stripMarkdown('- **やった** :tada: 終わり'), 'やった 🎉 終わり')
})
