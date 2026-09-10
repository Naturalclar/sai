import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PERSONA, PERSONAS, digestPrompt, isPersonaId, personaOf } from './persona.ts'

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
