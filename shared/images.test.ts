import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageKey, imageRefs, sessionImageUrl } from './images.ts'

test('imageKey: 16 桁の 16 進で、同じパスは同じ鍵・違うパスは違う鍵', () => {
  const a = imageKey('/Users/me/icon.png')
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.equal(imageKey('/Users/me/icon.png'), a)
  assert.notEqual(imageKey('/Users/me/icon2.png'), a)
  assert.notEqual(imageKey('docs/icon.png'), imageKey('docs/icon.PNG'))
  assert.match(imageKey(''), /^[0-9a-f]{16}$/)
})

test('imageRefs: 段落・箇条書き・見出し・引用・太字の中の画像を出てきた順に、同じパスは 1 つにする', () => {
  const text = [
    '# ![見出し](h.png)',
    'できました [codex-agent-icon.png](/abs/docs/codex-agent-icon.png)',
    '- **![太字](b.webp)**',
    '> ![引用](q.gif)',
    'もう一度 [codex-agent-icon.png](/abs/docs/codex-agent-icon.png)',
  ].join('\n\n')
  assert.deepEqual(imageRefs(text).map((r) => r.src), ['h.png', '/abs/docs/codex-agent-icon.png', 'b.webp', 'q.gif'])
  assert.deepEqual(imageRefs(text)[1], { src: '/abs/docs/codex-agent-icon.png', alt: 'codex-agent-icon.png' })
})

test('imageRefs: コードの中・外の URL の画像・画像でないパスは拾わない', () => {
  const text = ['```', '![x](in-fence.png)', '```', '`![y](inline.png)`', '![z](https://example.com/a.png)', '[notes](docs/notes.txt)'].join('\n')
  assert.deepEqual(imageRefs(text), [])
})

test('sessionImageUrl: id はエンコードし、パスは鍵にして URL に出さない', () => {
  const src = '/Users/me/secret dir/a.png'
  assert.equal(sessionImageUrl('S1@sai', src), `/api/sessions/S1%40sai/images/${imageKey(src)}`)
})
