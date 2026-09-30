import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { thumbFailure } from './thumb.ts'
import { formatImageBytes, thumbUrl } from '../../shared/images.ts'

const headers = (h: Record<string, string>) => new Headers(h)

test('thumbFailure: 503 + X-SAI-Thumb: unavailable だけが「押すまで読まない」。ほかは表示できません', () => {
  assert.deepEqual(thumbFailure(503, headers({ 'X-SAI-Thumb': 'unavailable', 'X-SAI-Image-Bytes': '2400000' })), { kind: 'heavy', bytes: 2400000 })
  assert.deepEqual(thumbFailure(503, headers({ 'X-SAI-Thumb': 'unavailable' })), { kind: 'heavy', bytes: 0 })
  assert.deepEqual(thumbFailure(503, headers({})), { kind: 'broken' })
  assert.deepEqual(thumbFailure(404, headers({ 'X-SAI-Thumb': 'unavailable' })), { kind: 'broken' })
})

test('thumbUrl / formatImageBytes', () => {
  assert.equal(thumbUrl('/api/sessions/a/images/k'), '/api/sessions/a/images/k?thumb=1')
  assert.equal(thumbUrl('/x?days=7'), '/x?days=7&thumb=1')
  assert.equal(formatImageBytes(2_400_000), '2.3MB')
  assert.equal(formatImageBytes(480 * 1024), '480KB')
})

test('枠の <img> は軽い版（ThumbImage）、ライトボックスとダウンロードは元の URL（#589）', () => {
  for (const name of ['MessageImages', 'MarkdownImage', 'AttachedImages']) {
    const src = readFileSync(resolve(import.meta.dirname, `${name}.tsx`), 'utf-8')
    assert.match(src, /<ThumbImage /, `${name} は ThumbImage を使う`)
    assert.doesNotMatch(src, /<img /, `${name} は元の URL を <img> に直接渡さない`)
    assert.doesNotMatch(src, /thumbUrl|thumb=1/, `${name} はライトボックス・ダウンロードに軽い版の URL を渡さない`)
  }
})
