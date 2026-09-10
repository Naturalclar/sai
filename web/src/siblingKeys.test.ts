// 同じ親の中で key が重なっていないかをソースから見る（#264）。
//
// React は同じ親の兄弟で key が重なると再調整で古い分を見つけられず、**更新のたびに増え続ける**。
// 手元では `.chat-head` の中で 4 つの兄弟が `key={s.id}` を共有していて、3 秒のポーリングごとに
// 「表示名なし」と許可モードの列が +3 ずつ積み上がった（本番ビルドでは React の重複 key の警告が
// 落ちているので、コンソールにも何も出ない）。
//
// DOM を作らないと本当の再調整は再現できないので、ここでは**同じ式の key が 2 回以上書かれていないか**
// という形で縛る。`key={\`meta:${s.id}\`}` のように接頭辞を付けていれば通る。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = resolve(import.meta.dirname)

/** `<開き>` から数えて釣り合う `<閉じ>` の次の位置。無ければ末尾 */
function matchingEnd(source: string, from: number, open: string, close: string): number {
  let depth = 1
  let i = from
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === open) depth++
    else if (source[i] === close) depth--
  }
  return i
}

/**
 * `.map(…)` の中身を落とす。**一覧の中の `key` は 1 回しか書かれない**ので重なりようがなく、
 * 別々の `.map()` が同じ `key={i}` を使うのは普通のこと（`Inlines.tsx` など）。
 * ここで見たいのは「静的に並べた兄弟」だけなので、先に外す
 */
export function withoutMapBodies(source: string): string {
  let out = ''
  let at = 0
  for (;;) {
    const found = source.indexOf('.map(', at)
    if (found < 0) return out + source.slice(at)
    out += source.slice(at, found)
    at = matchingEnd(source, found + '.map('.length, '(', ')')
  }
}

/** `key={…}` の中身を全部。`key="文字列"` は使っていないので `{}` だけ見る */
export function keyExpressions(source: string): string[] {
  const out: string[] = []
  const re = /\bkey=\{/g
  while (re.exec(source)) {
    // 対応する `}` まで（テンプレートリテラルの `${}` があるので括弧を数える）
    const end = matchingEnd(source, re.lastIndex, '{', '}')
    out.push(source.slice(re.lastIndex, end - 1).trim())
  }
  return out
}

test('keyExpressions: key={…} の中身を取り出す（テンプレートリテラルの ${} も数える）', () => {
  assert.deepEqual(keyExpressions('<A key={s.id} /><B key={`m:${s.id}`} />'), ['s.id', '`m:${s.id}`'])
  assert.deepEqual(keyExpressions('<A id={s.id} />'), [], 'key でないものは拾わない')
  assert.deepEqual(keyExpressions('<A key={x} />'), ['x'])
})

test('withoutMapBodies: 一覧の中の key は見ない（別々の .map が同じ key={i} を使うのは普通）', () => {
  const source = '<A key={s.id} />{xs.map((x, i) => <B key={i} />)}{ys.map((y, i) => <C key={i} />)}'
  assert.deepEqual(keyExpressions(withoutMapBodies(source)), ['s.id'])
  // 入れ子の括弧があっても閉じ位置を間違えない
  assert.deepEqual(keyExpressions(withoutMapBodies('{xs.map((x) => <B key={f(g(x))} />)}<A key={s.id} />')), ['s.id'])
})

/**
 * **静的に並べた兄弟で、同じ key の式を 2 回以上書かない。**
 *
 * 厳密には「同じ親の兄弟で」だが、親をソースから正しく取るには JSX のパーサが要る。
 * 1 ファイル = 1 コンポーネントというこのリポジトリの決まり（CLAUDE.md）があるので、
 * `.map()` の中を外したうえでファイル単位に見れば実用上は同じことになる。
 */
test('静的に並べた兄弟で key の式が重なっていない（#264）', () => {
  const offenders: string[] = []
  for (const name of readdirSync(SRC)) {
    if (!name.endsWith('.tsx')) continue
    const source = withoutMapBodies(readFileSync(join(SRC, name), 'utf-8'))
    const seen = new Map<string, number>()
    for (const key of keyExpressions(source)) seen.set(key, (seen.get(key) ?? 0) + 1)
    for (const [key, n] of seen) if (n > 1) offenders.push(`${name}: key={${key}} が ${n} 回`)
  }
  assert.deepEqual(
    offenders,
    [],
    '同じ親の兄弟で key が重なると、React が古い分を見つけられず更新のたびに増える（#264）。接頭辞を付けて別々の key にする',
  )
})
