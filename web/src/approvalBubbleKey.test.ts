// 許可のバブルは許可ごとに作り直す（#492）。
//
// `ApprovalBubble` は押した直後の表示（`done` / `busy` / `error`）をローカルな state に持つ。
// 同じ場所に**次の許可**が来たとき、React が同じ部品を使い回すと前の許可の「拒否した」が残り、
// 次の許可が押せなくなる。要対応の画面（`TodoRow`）は行の key がセッション ID なので、同じセッションに
// 許可が 2 つ並ぶと 1 つ目に答えたあとちょうどこうなった（`SessionView` / `FeedView` は元から付いていた）。
//
// DOM を作らないと再調整は再現できないので、**`<ApprovalBubble` には必ず `approval_id` の key を書く**
// という形でソースから縛る
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = resolve(import.meta.dirname)

test('<ApprovalBubble> には必ず approval_id の key を付ける（#492）', () => {
  const uses: string[] = []
  const missing: string[] = []
  for (const name of readdirSync(SRC).filter((f) => f.endsWith('.tsx'))) {
    const source = readFileSync(join(SRC, name), 'utf8')
    for (const m of source.matchAll(/<ApprovalBubble\b[^>]*?\/>/gs)) {
      uses.push(name)
      if (!/\bkey=\{[^}]*\.approval_id\}/.test(m[0])) missing.push(`${name}: ${m[0].slice(0, 80)}`)
    }
  }
  // 1 つも見つからなければ正規表現の方が壊れている（通って見えるだけになる）
  assert.ok(uses.length >= 3, `ApprovalBubble の使い所が ${uses.length} か所しか見つからない`)
  assert.deepEqual(missing, [])
})
