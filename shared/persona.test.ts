import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PERSONA, PERSONAS, digestPrompt, isPersonaId, personaOf } from './persona.ts'
import { digestIssues } from './digestCheck.ts'

test('PERSONAS: 性格なし + MBTI 16 で、id は重複しない', () => {
  assert.equal(PERSONAS.length, 17)
  assert.equal(new Set(PERSONAS.map((p) => p.id)).size, 17)
  assert.ok(PERSONAS.some((p) => p.id === 'none'))
  assert.ok(isPersonaId(DEFAULT_PERSONA))
})

test('isPersonaId / personaOf: 知らない値は既定に落ちる', () => {
  assert.equal(isPersonaId('ENFP'), true)
  assert.equal(isPersonaId('none'), true)
  assert.equal(isPersonaId('enfp'), false)
  assert.equal(isPersonaId(''), false)
  assert.equal(isPersonaId(1), false)
  assert.equal(personaOf('ISTJ').id, 'ISTJ')
  assert.equal(personaOf('XXXX').id, DEFAULT_PERSONA)
  assert.equal(personaOf(undefined).id, DEFAULT_PERSONA)
})

test('digestPrompt: 共通の骨格 + 口調 + 本文。本文は末尾にそのまま入る', () => {
  const text = 'PR #35 を squash マージしました。\n- main は fad19a4'
  const p = digestPrompt('ISTJ', text)
  assert.match(p, /1〜2 文、80 文字以内/)
  assert.match(p, /番号（`#` に続く数字や PR の番号）/)
  // 番号だけでなく「何をするものか」も残させる（#165）
  assert.match(p, /issue \/ PR の番号には「何をするものか」を短く添える/)
  assert.match(p, /本文から分からなければ番号だけでよい/)
  // 例に実在の番号を使うと、関係ない行でもモデルがそれを書き写す
  assert.doesNotMatch(p, /#163|worktree 名でなく/, '例は無関係な題材にする')
  assert.ok(p.includes(personaOf('ISTJ').tone))
  assert.ok(p.endsWith(`---\n${text}`))
  const q = digestPrompt('ENFP', text)
  assert.notEqual(p, q)
  assert.ok(q.includes(personaOf('ENFP').tone))
})

// ---- #268: 作例の数字をそのまま書き写すので、プロンプトに具体的な番号を置かない

test('digestPrompt: 指示の部分に書き写せる番号（#<数字>）が無い', () => {
  // 本文は末尾に丸ごと入るので、指示の部分（--- より前）だけを見る
  const head = digestPrompt('none', '#12345 を見た').split('\n---\n')[0]!
  assert.doesNotMatch(head, /#\d/, '作例に数字があると、番号の無いターンでもそれを書き写す')
  // 本文側は今までどおりそのまま入る（指示だけを見ていることの裏取り）
  assert.match(digestPrompt('none', '#12345 を見た'), /#12345/)
})

test('digestPrompt: 「本文に無い番号は書かない」が入っている', () => {
  assert.match(digestPrompt('none', 'x'), /本文に出てこない番号は書かない/)
})

// ---- #346: 引用された依頼を守る規則と、作り直しのプロンプト
test('digestPrompt: 引用された依頼を引用のまま残す規則が入っている（#346）', () => {
  const p = digestPrompt('ESFP', 'よければ「マージして」と言ってください。')
  assert.match(p, /引用された依頼/)
  assert.match(p, /引用のまま残す/)
  assert.match(p, /問いかけに変えない/)
})

test('digestPrompt: 作り直しは前の一言と直してほしい点を足す。本文は末尾のまま（#346）', () => {
  const text = 'PR #284 を出しました。よければ「マージして」と言ってください。'
  const issues = digestIssues(text, 'PR #284 出したよ、マージして？')
  const p = digestPrompt('ESFP', text, { summary: 'PR #284 出したよ、マージして？', issues })
  assert.match(p, /前に作った一言: PR #284 出したよ、マージして？/)
  assert.match(p, /直して作り直してください/)
  assert.ok(issues.every((i) => p.includes(i.hint)), '見つけた点をそのまま伝える')
  assert.ok(p.endsWith(`---\n${text}`), '本文は末尾のまま')
  // 作り直しでない普通のプロンプトには足さない
  assert.doesNotMatch(digestPrompt('ESFP', text), /前に作った一言/)
})

test('digestPrompt: 話の筋（意図・理由・いまの状態・人がすること）を求める（#359）', () => {
  const p = digestPrompt('ESFP', 'PR を出しました。CI を待っています。')
  assert.match(p, /話の筋を残す/)
  assert.match(p, /何をしようとしたか/)
  assert.match(p, /人が次にすること/)
  assert.match(p, /本文に書かれていない理由・次の一手は書かない/, '推測で補わせない（#268 と同じ）')
  assert.match(p, /人がすること（「〜と言ってください」「〜してください」、質問）は必ず残す/)
  assert.match(p, /何を待っていて、終わったらどうなるか/)
  // 前の「何をしたかだけ」は消えている（意図と理由まで落ちていた）
  assert.doesNotMatch(p, /何をしたか（と、あれば次の一手や確認したいこと）だけ/)
})
