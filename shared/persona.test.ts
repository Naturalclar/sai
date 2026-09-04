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
  assert.match(p, /1〜2 文、60 文字以内/)
  assert.match(p, /番号（#35、PR #12 など）/)
  assert.ok(p.includes(personaOf('ISTJ').tone))
  assert.ok(p.endsWith(`---\n${text}`))
  const q = digestPrompt('ENFP', text)
  assert.notEqual(p, q)
  assert.ok(q.includes(personaOf('ENFP').tone))
})
