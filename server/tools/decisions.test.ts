import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GhIssues, ISSUES_CLOSED_LIMIT, ISSUES_OPEN_LIMIT, issuesFromEnv } from '../git/issues.ts'
import type { GhRun } from '../git/prs.ts'
import { render, run } from './decisions.ts'
import { DECISION_LINE_CHARS, listItems, mentionedNumbers, namedAtHead, namedInTitle, parseSources, pendingAll, pendingOf, recommendOf, sections } from './decisionsRead.ts'
import type { DecisionSource } from './decisionsRead.ts'

// 事例は全部作り物の文（実際の issue の文は貼らない）

const issue = (over: Partial<DecisionSource> = {}): DecisionSource => ({
  kind: 'issue',
  number: 10,
  title: '色を選べるようにする',
  state: 'open',
  body: '',
  createdAt: '2026-10-01T03:00:00Z',
  comments: [],
  ...over,
})

const BODY = `## 何がしたいか

色を選びたい。

## 決めること

1. **既定の色。** 青か緑か。おすすめは青（いまの見た目に近い）
2. 色の数の上限
   - 8 か 16
3. 設定の置き場

## テスト

1. これは決めることではない
`

const brief = (src: DecisionSource) => pendingOf(src).map((p) => `${p.from}${p.n ?? ''}`)

test('sections: 見出しの下を、同じか上の階層の見出しまで拾う。コードブロックの中の # は見出しにしない', () => {
  const md = '# 題\n## 決めること\n1. a\n### 補足\n- b\n```\n## 決めること\n```\n## 次\n1. c\n'
  const found = sections(md, (t) => t.startsWith('決めること'))
  assert.equal(found.length, 1)
  assert.deepEqual(found[0]!.lines, ['1. a', '### 補足', '- b', '```', '## 決めること', '```'])
  // 「人が決めること」「3. …（決めること 1）」は「決めること」で始まらない
  assert.equal(sections('## 人が決めること\n- a\n### 3. 出すか（決めること 1）\n- b', (t) => t.startsWith('決めること')).length, 0)
  // 字下げした見出し・閉じの # ・HTML コメントの中・当たった節の中の当たる小見出し
  const ask = (t: string) => t.startsWith('決めること')
  assert.deepEqual(sections('  ## 決めること ##\n1. a', ask).map((s) => [s.title, s.lines]), [['決めること', ['1. a']]])
  assert.equal(sections('<!--\n## 決めること\n1. 雛形\n-->\n本文', ask).length, 0)
  assert.equal(sections('<!-- ## 決めること', ask).length, 0)
  assert.deepEqual(sections('## 決めること\n1. a\n### 決めること（補足）\n2. b', ask).map((s) => s.lines), [['1. a', '### 決めること（補足）', '2. b']])
  // 長い 1 行で止まらない（見出しにも見ない）
  const started = Date.now()
  assert.equal(sections(`# a${' '.repeat(60000)}b\n# ${'#'.repeat(60000)}x\n## 決めること\n1. a`, ask).length, 1)
  assert.ok(Date.now() - started < 2000)
})

test('listItems: いちばん上の階層の箇条書きだけが項目。続きの行と入れ子は前の項目に付く。「なし」は 0 件', () => {
  const items = listItems(['1. **一つ目。** 説明', '   続き', '   - 入れ子', '', '2) 二つ目', '- 番号なし', '```', '9. コードの中', '```'])
  assert.deepEqual(items.map((i) => [i.n, i.head]), [[1, '**一つ目。** 説明'], [2, '二つ目'], [undefined, '番号なし']])
  assert.match(items[0]!.whole, /続き\n- 入れ子/)
  assert.deepEqual(listItems(['なし']), [])
  assert.deepEqual(listItems(['- なし']), [])
  assert.deepEqual(listItems(['', '  ']), [])
  // 箇条書きが無ければ、最初の段落の 1 行目
  assert.deepEqual(listItems(['色をどうするか。', '続きの説明']).map((i) => i.head), ['色をどうするか。'])
  // いちばん上の階層が字下げされていても（3 字まで）全部拾う。入れ子は項目にしない
  assert.deepEqual(listItems(['  1. a', '     - 入れ子', '  2. b']).map((i) => [i.n, i.head]), [[1, 'a'], [2, 'b']])
  // 長さの違うフェンス・別の字のフェンスでは閉じない
  assert.deepEqual(listItems(['````', '```', '1. コードの中', '```', '````', '1. 外']).map((i) => i.head), ['外'])
  assert.deepEqual(listItems(['```', '~~~', '1. コードの中', '```', '1. 外']).map((i) => i.head), ['外'])
})

test('namedAtHead / namedInTitle: 決まったと読むのは、項目の頭か見出しで番号を名指しした書き方だけ', () => {
  assert.deepEqual(namedAtHead('決めること 2: 青にする'), [2])
  assert.deepEqual(namedAtHead('**決めること 2（URL）: 案のとおり。**'), [2])
  assert.deepEqual(namedAtHead('「決めること」1・3'), [1, 3])
  assert.deepEqual(namedAtHead('決めること 1〜4: 案のとおり'), [1, 2, 3, 4])
  assert.deepEqual(namedAtHead('決めること１、３：案のとおり'), [1, 3])
  // 文の途中で触れただけ・保留・助数詞・ハイフン・数字の続きは、決まったと読まない
  assert.deepEqual(namedAtHead('色は青にする（決めること 2）'), [2], '終わりに番号だけを括弧で添えた形')
  assert.deepEqual(namedAtHead('色は青（`a`。b）。数も同じ（決めること 2・3）。'), [2, 3])
  for (const text of ['色は青（決めること 2）にして、あとは任せる', '色は青（決めること 2 は別）', '決めること 3 はまだ決めない', '決めること 4 を人に聞く', '決めること 2 - 8 色にする', '決めること 2、8 色にする', '本文の決めること 3 つのうち 1 つだけ決めた', '決めることは無い。3 つ直した', '1. 青にする', '']) {
    assert.deepEqual(namedAtHead(text), [], text)
  }
  assert.deepEqual(namedAtHead('決めること 1: 青にする（決めること 2 が決まるまでの仮）'), [1])
  assert.deepEqual(namedInTitle('決めたこと（2026-10-02。本文の「決めること」1・2）'), [1, 2])
  assert.deepEqual(namedInTitle('決めたこと: 色（2026-10-09。決めること 2）'), [2])
  assert.deepEqual(namedInTitle('決めたこと（決めること 1〜3）'), [1, 2, 3])
  assert.deepEqual(namedInTitle('決めたこと（2026-10-09）'), [])
  assert.deepEqual(namedInTitle('決めたこと（決めること 3 つのうち 1 つ）'), [])
  assert.deepEqual(namedInTitle('決めたこと（決めること 2 は保留）'), [])
  assert.deepEqual(namedInTitle('決めたこと（決めること 2: 保留）'), [])
  // ほかの issue の「決めること」は、この issue の番号にしない
  assert.deepEqual(namedInTitle('決めたこと（2026-10-09。#12 の決めること 2）'), [])
  assert.deepEqual(namedInTitle('決めたこと（#12 の「決めること」1・2）'), [])
})

test('mentionedNumbers: 決まっていない側に戻すときは、触れているだけの番号も読む', () => {
  assert.deepEqual(mentionedNumbers('上限（決めること 2）'), [2])
  assert.deepEqual(mentionedNumbers('決めること 5 と、決めること 2 は決め直す'), [2, 5])
  assert.deepEqual(mentionedNumbers('「決めること」1〜3 は持ち越し'), [1, 2, 3])
  assert.deepEqual(mentionedNumbers('決めること 2 - 8 色にする'), [2], 'ハイフンは範囲にしない')
  assert.deepEqual(mentionedNumbers('決めることは無い'), [])
})

test('recommendOf: 項目の中の「おすすめ」の 1 文だけ', () => {
  assert.equal(recommendOf('**既定の色。** 青か緑か。おすすめは青（いまの見た目に近い）。あとは任せる'), 'おすすめは青（いまの見た目に近い）')
  assert.equal(recommendOf('色の数（おすすめ: 8）'), 'おすすめ: 8')
  assert.equal(recommendOf('色の数'), undefined)
  assert.ok([...recommendOf(`おすすめは${'あ'.repeat(300)}`)!].length <= 80)
  // 前にある括弧の中身（選択肢）を、おすすめとして出さない
  assert.equal(recommendOf('上限の数（8 か 16）— おすすめは 8'), 'おすすめは 8')
  assert.equal(recommendOf('既定の色(青か緑)はどちらか、おすすめは青'), 'おすすめは青')
  assert.equal(recommendOf('色の数（8 か 16。おすすめは 8（軽い）にする）を決める'), 'おすすめは 8（軽い）にする')
  // 括弧の中が「おすすめ」だけなら、何がおすすめかごと
  assert.equal(recommendOf('青（おすすめ）か緑'), '青（おすすめ）')
  assert.equal(recommendOf('候補: 青、緑（おすすめ）、赤'), '緑（おすすめ）')
  assert.equal(recommendOf('（おすすめ）'), undefined)
})

test('pendingOf: 本文の「決めること」を番号つきで拾う。ほかの見出しの箇条書きは拾わない', () => {
  const got = pendingOf(issue({ body: BODY }))
  assert.deepEqual(got.map((p) => [p.n, p.from, p.text, p.date, p.recommend]), [
    [1, 'body', '既定の色。 青か緑か。おすすめは青（いまの見た目に近い）', '2026-10-01', 'おすすめは青（いまの見た目に近い）'],
    [2, 'body', '色の数の上限', '2026-10-01', undefined],
    [3, 'body', '設定の置き場', '2026-10-01', undefined],
  ])
  assert.deepEqual([got[0]!.number, got[0]!.title, got[0]!.kind, got[0]!.state], [10, '色を選べるようにする', 'issue', 'open'])
  // 項目の 1 行は切る（本文を載せない）
  const long = pendingOf(issue({ body: `## 決めること\n1. ${'長'.repeat(500)}` }))[0]!
  assert.equal([...long.text].length, DECISION_LINE_CHARS)
})

test('pendingOf: 「決めたこと」で番号を名指しされた項目は消え、残りが出る。見出しに書いた番号も読む', () => {
  const one = issue({ body: BODY, comments: [{ createdAt: '2026-10-02T00:00:00Z', body: '## 決めたこと（2026-10-02）\n\n- **決めること 2: 8 にする。**\n' }] })
  assert.deepEqual(brief(one), ['body1', 'body3'])
  const head = issue({ body: BODY, comments: [{ createdAt: '2026-10-02T00:00:00Z', body: '## 決めたこと（2026-10-02。本文の「決めること」1・3）\n\n案のとおり。\n' }] })
  assert.deepEqual(brief(head), ['body2'])
  const all = issue({ body: BODY, comments: [{ createdAt: '2026-10-02T00:00:00Z', body: '## 決めたこと（決めること 1〜3）\n案のとおり' }] })
  assert.deepEqual(brief(all), [])
})

test('pendingOf: 番号で突き合わせられない「決めたこと」では、決まったと見なさない（出しすぎる側）', () => {
  const loose = issue({ body: BODY, comments: [{ createdAt: '2026-10-02T00:00:00Z', body: '## 決めたこと（2026-10-02）\n\n- 既定の色は青にする\n1. 上限は 8\n' }] })
  assert.deepEqual(brief(loose), ['body1', 'body2', 'body3'])
  // 「決めたこと」の見出しの外で番号を挙げても、決まったことにしない
  const outside = issue({ body: BODY, comments: [{ createdAt: '2026-10-02T00:00:00Z', body: '決めること 1 は青がよさそうです。' }] })
  assert.deepEqual(brief(outside), ['body1', 'body2', 'body3'])
  // 本文の項目に番号が無ければ、消せない
  const bullets = issue({ body: '## 決めること\n- 色\n- 数\n', comments: [{ createdAt: '2026-10-02T00:00:00Z', body: '## 決めたこと\n- 決めること 1: 青' }] })
  assert.deepEqual(brief(bullets), ['body', 'body'])
})

test('pendingOf: 「まだ決めていないこと」に挙がった番号は決まっていない側。番号の無い項目は、いちばん新しいものをそのまま出す', () => {
  const src = issue({
    body: BODY,
    comments: [
      { createdAt: '2026-10-02T00:00:00Z', body: '## 決めたこと（2026-10-02）\n- 決めること 1: 青\n\n### まだ決めていないこと\n- 上限（決めること 2）\n- 置き場（決めること 3）\n- 暗い画面の色をどうするか\n' },
      { createdAt: '2026-10-04T00:00:00Z', body: '## 決めたこと（2026-10-04。決めること 2）\n8 にする\n\n### まだ決めていないこと\n- 置き場（決めること 3）\n- 色の名前を付けるか。おすすめは付けない\n' },
    ],
  })
  const got = pendingOf(src)
  assert.deepEqual(got.map((p) => [p.from, p.n, p.text, p.date]), [
    ['body', 3, '設定の置き場', '2026-10-01'],
    ['remaining', undefined, '色の名前を付けるか。おすすめは付けない', '2026-10-04'],
  ])
  assert.equal(got[1]!.recommend, 'おすすめは付けない')
  // あとの「まだ決めていないこと」が、前に決まった番号を戻す
  const back = issue({
    body: BODY,
    comments: [
      { createdAt: '2026-10-02T00:00:00Z', body: '## 決めたこと（決めること 1〜3）\n案のとおり' },
      { createdAt: '2026-10-03T00:00:00Z', body: '## 決めたこと（2026-10-03）\n\n### まだ決めていないこと\n- 決めること 2 は決め直す' },
    ],
  })
  assert.deepEqual(brief(back), ['body2', 'remaining'], '本文の項目を指すだけの書き方でなければ、その項目も出す')
  // コメントは時刻の順に読む（並びが逆でも同じ）
  assert.deepEqual(brief({ ...back, comments: [...parseSources(JSON.stringify([{ number: 10, comments: [...back.comments].reverse() }]), 'issue', 'open')![0]!.comments] }), ['body2', 'remaining'])
})

test('pendingOf: 「決めたこと」の中で番号に触れただけでは消さない（仮・保留・小見出しの下・引用・コードブロック）', () => {
  const decidedWith = (text: string) => brief(issue({ body: BODY, comments: [{ createdAt: '2026-10-02T00:00:00Z', body: `## 決めたこと（2026-10-02）\n\n${text}\n` }] }))
  assert.deepEqual(decidedWith('- 決めること 1: 青にする（決めること 2 が決まるまでの仮）'), ['body2', 'body3'])
  assert.deepEqual(decidedWith('- 決めること 3 はまだ決めない'), ['body1', 'body2', 'body3'])
  assert.deepEqual(decidedWith('- 決めること 1: 青\n\n### 次にやること\n- 決めること 3: 人に聞く'), ['body2', 'body3'])
  assert.deepEqual(decidedWith('> 決めること 3: どうしますか'), ['body1', 'body2', 'body3'])
  assert.deepEqual(decidedWith('```\n- 決めること 3: x\n```'), ['body1', 'body2', 'body3'])
  assert.deepEqual(decidedWith('- 決めること 2 - 3 色にする'), ['body1', 'body2', 'body3'])
  assert.deepEqual(decidedWith('本文の決めること 3 つのうち 1 つだけ決めた'), ['body1', 'body2', 'body3'])
  // 見出しにしていない「まだ決めていないこと」（太字の行）から下も、決まったと読まない
  assert.deepEqual(decidedWith('- 決めること 1: 青\n\n**まだ決めていないこと**\n- 決めること 2: 上限は保留\n- 決めること 3（置き場）'), ['body2', 'body3'])
  assert.deepEqual(decidedWith('- 決めること 1: 青\n- まだ決めていないこと:\n  - 決めること 2: 保留'), ['body2', 'body3'])
  // ほかの issue の番号・HTML コメントの中
  assert.deepEqual(brief(issue({ body: BODY, comments: [{ createdAt: '2026-10-02T00:00:00Z', body: '## 決めたこと（#12 の決めること 2）\n- 向こうは青' }] })), ['body1', 'body2', 'body3'])
  assert.deepEqual(brief(issue({ body: BODY, comments: [{ createdAt: '2026-10-02T00:00:00Z', body: '<!-- ## 決めたこと（決めること 1〜3） -->\nまだです' }] })), ['body1', 'body2', 'body3'])
})

test('pendingOf: 本文で同じ番号が 2 回出てくるなら突き合わせない。「まだ決めていないこと」が本文に無い番号に触れていれば、その項目も出す', () => {
  const same = issue({ body: '## 決めること\n1. 色\n1. 数\n1. 置き場\n', comments: [{ createdAt: '2026-10-02T00:00:00Z', body: '## 決めたこと\n- 決めること 1: 青' }] })
  assert.deepEqual(brief(same), ['body1', 'body1', 'body1'])
  const two = issue({ body: '## 決めること\n1. 色\n2. 数\n\n## 決めること（追加）\n1. 置き場\n', comments: [{ createdAt: '2026-10-02T00:00:00Z', body: '## 決めたこと（決めること 1・2）' }] })
  assert.deepEqual(brief(two), ['body1', 'body1'])
  // 続き番号でない本文（表示では 1・2・3 になる）は突き合わせない
  const gap = issue({ body: '## 決めること\n1. 色\n3. 数\n4. 置き場\n', comments: [{ createdAt: '2026-10-02T00:00:00Z', body: '## 決めたこと（決めること 3）' }] })
  assert.deepEqual(brief(gap), ['body1', 'body3', 'body4'])
  const remainingWith = (text: string, over: Partial<DecisionSource> = {}) => brief(issue({ body: BODY, ...over, comments: [{ createdAt: '2026-10-02T00:00:00Z', body: `## 決めたこと（決めること 1〜3）\n\n### まだ決めていないこと\n${text}\n` }] }))
  assert.deepEqual(remainingWith('- 暗い画面の色（決めること 6 として足す）'), ['remaining'])
  assert.deepEqual(remainingWith('- 色の名前を付けるか（決めること 1 とは別の話）'), ['body1', 'remaining'])
  assert.deepEqual(remainingWith('- 暗い画面（決めること 9）', { state: 'closed' }), ['remaining'])
  assert.deepEqual(remainingWith('- 決めること 2 の数は未定', { state: 'closed', body: '## 決めること\n- 色\n- 数\n' }), ['remaining'])
  // 同じコメントの中に節が 2 つあれば足し合わせる
  assert.deepEqual(remainingWith('- 件 A\n\n## 別\n\n### まだ決めていないこと（追加）\n- 置き場（決めること 3）'), ['body3', 'remaining'])
})

test('pendingOf: 閉じた issue は「決めないまま閉じること」だけ。無ければ「まだ決めていないこと」だけで、本文の決めることは出さない', () => {
  const closed = issue({ state: 'closed', body: BODY })
  assert.deepEqual(brief(closed), [], '閉じた issue の本文の項目は出さない')
  const left = issue({ state: 'closed', body: BODY, comments: [{ createdAt: '2026-10-05T00:00:00Z', body: '入りました。\n\n### 決めないまま閉じること\n- 暗い画面の色\n- 色の名前\n' }] })
  assert.deepEqual(pendingOf(left).map((p) => [p.from, p.text, p.date, p.state]), [
    ['closing', '暗い画面の色', '2026-10-05', 'closed'],
    ['closing', '色の名前', '2026-10-05', 'closed'],
  ])
  const remaining = issue({ state: 'closed', body: BODY, comments: [{ createdAt: '2026-10-03T00:00:00Z', body: '## 決めたこと\n- 決めること 2: 8\n### まだ決めていないこと\n- **決めること 1: 既定の色**\n- 暗い画面の色\n' }] })
  assert.deepEqual(brief(remaining), ['body1', 'remaining'])
  // 「決めないまま閉じること」に「なし」と書けば 0 件（前の「まだ決めていないこと」も出さない）
  const none = issue({ ...remaining, comments: [...remaining.comments, { createdAt: '2026-10-06T00:00:00Z', body: '### 決めないまま閉じること\nなし' }] })
  assert.deepEqual(brief(none), [])
})

test('pendingOf: PR は本文の「人が決めること」を全部。「変えるならここ」やほかの見出しは拾わない', () => {
  const pr: DecisionSource = { kind: 'pr', number: 20, title: '色を足す', state: 'open', createdAt: '2026-10-03T15:30:00Z', comments: [], body: '## 何をしたか\n- a\n\n## 人が決めること\n\n- 既定を青にしてよいか\n1. 上限を 8 にしてよいか\n\n## 変えるならここ（仮に置いたこと）\n- 上限 8\n' }
  assert.deepEqual(pendingOf(pr).map((p) => [p.from, p.n, p.text, p.date]), [
    ['pr', undefined, '既定を青にしてよいか', '2026-10-04'],
    ['pr', undefined, '上限を 8 にしてよいか', '2026-10-04'],
  ])
  assert.deepEqual(pendingOf({ ...pr, body: '## 人が決めること\n\nなし\n' }), [])
})

test('pendingAll / render: 番号の新しい順に並べ、1 件ごとに見出し 1 行・項目 1 行・おすすめ 1 行。本文は載せない', () => {
  const lines = render(pendingAll([issue({ body: BODY }), { ...issue({ number: 30, title: '閉じたもの', state: 'closed' }), comments: [{ createdAt: '2026-10-05T00:00:00Z', body: '### 決めないまま閉じること\n- 残り' }] }, { kind: 'pr', number: 20, title: '色を足す', state: 'open', createdAt: '2026-10-03T00:00:00Z', comments: [], body: '## 人が決めること\n- よいか' }]))
  assert.deepEqual(lines, [
    '#30（閉じた） 閉じたもの',
    '  2026-10-05 決めないまま閉じること: 残り',
    'PR #20 色を足す',
    '  2026-10-03 人が決めること: よいか',
    '#10 色を選べるようにする',
    '  2026-10-01 決めること 1: 既定の色。 青か緑か。おすすめは青（いまの見た目に近い）',
    '    → おすすめは青（いまの見た目に近い）',
    '  2026-10-01 決めること 2: 色の数の上限',
    '  2026-10-01 決めること 3: 設定の置き場',
  ])
})

test('parseSources: gh の JSON を読む。壊れた出力・引けなかったものは null、形の違う項目は捨てる', () => {
  assert.equal(parseSources(null, 'issue', 'open'), null)
  assert.equal(parseSources('{', 'issue', 'open'), null)
  assert.equal(parseSources('{}', 'issue', 'open'), null)
  const got = parseSources(JSON.stringify([{ number: 1, title: 't', body: 'b', createdAt: 'x', comments: [{ body: 'c', createdAt: '2' }, { nope: 1 }, { body: 'a', createdAt: '1' }] }, { title: '番号なし' }, null]), 'issue', 'closed')!
  assert.deepEqual(got, [{ kind: 'issue', state: 'closed', number: 1, title: 't', body: 'b', createdAt: 'x', comments: [{ body: 'a', createdAt: '1' }, { body: 'c', createdAt: '2' }] }])
})

/** 呼ばれた引数を覚える偽の gh */
function fakeGh(answer: (args: string[]) => string | null): { run: GhRun; calls: string[][] } {
  const calls: string[][] = []
  return { calls, run: (args) => (calls.push(args), Promise.resolve(answer(args))) }
}

test('GhIssues: gh に渡すのは読むだけの決め打ちの 3 形。リポジトリと日付の形が違えば叩かない', async () => {
  const gh = fakeGh(() => '[]')
  const issues = new GhIssues(gh.run)
  await issues.open('acme/app')
  await issues.closed('acme/app', '2026-09-27')
  await issues.prs('acme/app')
  assert.deepEqual(gh.calls, [
    ['issue', 'list', '--repo', 'acme/app', '--state', 'open', '--limit', String(ISSUES_OPEN_LIMIT), '--json', 'number,title,body,createdAt,comments'],
    ['issue', 'list', '--repo', 'acme/app', '--state', 'closed', '--limit', String(ISSUES_CLOSED_LIMIT), '--search', 'closed:>=2026-09-27', '--json', 'number,title,body,createdAt,comments'],
    ['pr', 'list', '--repo', 'acme/app', '--state', 'open', '--limit', String(ISSUES_OPEN_LIMIT), '--json', 'number,title,body,createdAt'],
  ])
  gh.calls.length = 0
  assert.equal(await issues.open('--web'), null)
  assert.equal(await issues.open('acme'), null)
  assert.equal(await issues.prs('acme/app extra'), null)
  assert.equal(await issues.closed('acme/app', '2026-09-27 is:open'), null)
  assert.equal(await issues.closed('acme/app', ''), null)
  assert.deepEqual(gh.calls, [])
})

/** `run()` を偽の gh で回して、出た行を集める */
async function cli(argv: string[], answer: ((args: string[]) => string | null) | null, repo = 'acme/app') {
  const out: string[] = []
  const err: string[] = []
  const gh = answer ? fakeGh(answer) : null
  const code = await run(argv, { repo, gh: gh ? new GhIssues(gh.run) : null, now: new Date('2026-10-11T03:00:00Z'), out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out, err, calls: gh?.calls ?? [] }
}

const OPEN = JSON.stringify([{ number: 10, title: '色を選べるようにする', body: BODY, createdAt: '2026-10-01T03:00:00Z', comments: [{ body: '## 決めたこと（決めること 1・2）', createdAt: '2026-10-02T00:00:00Z' }] }])
const CLOSED = JSON.stringify([{ number: 7, title: '閉じたもの', body: BODY, createdAt: '2026-09-30T00:00:00Z', comments: [{ body: '### 決めないまま閉じること\n- 残り', createdAt: '2026-10-05T00:00:00Z' }] }])
const PRS = JSON.stringify([{ number: 20, title: '色を足す', body: '## 人が決めること\n- よいか', createdAt: '2026-10-03T00:00:00Z' }])
const answers = (args: string[]): string | null => (args[0] === 'pr' ? PRS : args.includes('closed') ? CLOSED : OPEN)

test('decisions: open な issue・PR と、14 日までに閉じた issue の未決を 1 つの一覧にする', async () => {
  const r = await cli([], answers)
  assert.equal(r.code, 0)
  assert.deepEqual(r.out, [
    'まだ決まっていないこと: 3 件（3 か所。open な issue 1・閉じた issue 1・PR 1。閉じた issue は 2026-09-27（UTC）以降）',
    'PR #20 色を足す',
    '  2026-10-03 人が決めること: よいか',
    '#10 色を選べるようにする',
    '  2026-10-01 決めること 3: 設定の置き場',
    '#7（閉じた） 閉じたもの',
    '  2026-10-05 決めないまま閉じること: 残り',
  ])
  assert.deepEqual(r.err, [])
  assert.ok(r.calls.some((c) => c.includes('closed:>=2026-09-27')), '14 日前から')
  // 日付は UTC で切る（東京では 10-11 でも、UTC の 10-10 から 14 日前）
  const out: string[] = []
  const early = fakeGh(answers)
  await run([], { repo: 'acme/app', gh: new GhIssues(early.run), now: new Date('2026-10-10T20:00:00Z'), out: (l) => out.push(l), err: () => {} })
  assert.ok(early.calls.some((c) => c.includes('closed:>=2026-09-26')))
  // --days で遡る日数を変える。0 なら閉じた issue を引かない
  assert.ok((await cli(['--days', '30'], answers)).calls.some((c) => c.includes('closed:>=2026-09-11')))
  const none = await cli(['--days', '0'], answers)
  assert.equal(none.calls.length, 2)
  assert.match(none.out[0]!, /2 件.*閉じた issue は引いていない/)
  // --json は 1 行 1 項目
  const json = await cli(['--json'], answers)
  assert.deepEqual(json.out.map((l) => JSON.parse(l).number), [20, 10, 7])
})

test('decisions: SAI_GH=0 なら何も引かない。引けなかったものは 0 件と混ぜずに知らせる。知らない引数は使い方', async () => {
  const off = await cli([], null)
  assert.deepEqual([off.code, off.out, off.calls], [0, [], []])
  assert.match(off.err[0]!, /SAI_GH=0/)
  const norepo = await cli([], answers, '')
  assert.deepEqual([norepo.code, norepo.calls], [1, []])
  const partial = await cli([], (args) => (args.includes('closed') ? null : answers(args)))
  assert.equal(partial.code, 1)
  assert.match(partial.err[0]!, /引けませんでした: 閉じた issue/)
  assert.match(partial.out[0]!, /2 件/)
  for (const bad of [['--days', 'x'], ['--days', '-1'], ['--days', ''], ['--days=1e1'], ['--days', '0x10'], ['--days', '366'], ['--repo', 'other/repo'], ['extra']]) {
    const r = await cli(bad, answers)
    assert.deepEqual([r.code, r.calls.length], [2, 0], bad.join(' '))
  }
  // 切れているかもしれないときは知らせる
  const many = await cli([], (args) => (args.includes('closed') ? JSON.stringify(Array.from({ length: ISSUES_CLOSED_LIMIT }, (_, i) => ({ number: i + 1 }))) : '[]'))
  assert.match(many.err.join('\n'), /閉じた issue が \d+ 件に届いた/)
  const full = JSON.stringify(Array.from({ length: ISSUES_OPEN_LIMIT }, (_, i) => ({ number: i + 1 })))
  const wide = await cli([], (args) => (args.includes('closed') ? '[]' : full))
  assert.match(wide.err.join('\n'), /open な issue が \d+ 件に届いた/)
  assert.match(wide.err.join('\n'), /open な PR が \d+ 件に届いた/)
})

test('issuesFromEnv: SAI_GH=0 なら口を組まない（gh を起こすものが無い）', () => {
  const before = process.env.SAI_GH
  try {
    process.env.SAI_GH = '0'
    assert.equal(issuesFromEnv(), null)
    delete process.env.SAI_GH
    assert.ok(issuesFromEnv() instanceof GhIssues)
  } finally {
    if (before === undefined) delete process.env.SAI_GH
    else process.env.SAI_GH = before
  }
})
