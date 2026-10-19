import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IMAGE_UNAVAILABLE } from '../../shared/images.ts'
import { imageUnavailableText } from './imageUnavailable.ts'

test('imageUnavailableText: 区分ごとに短い理由とどうすれば出るかの 1 行。/tmp は本文のパスから見分ける（#820）', () => {
  assert.equal(imageUnavailableText('outside', '/tmp/shot.png').label, '作業ディレクトリの外（/tmp）')
  assert.equal(imageUnavailableText('outside', '/private/tmp/shot.png').label, '作業ディレクトリの外（/tmp）')
  assert.equal(imageUnavailableText('outside', '../other/shot.png').label, '作業ディレクトリの外')
  assert.match(imageUnavailableText('outside', '/tmp/shot.png').hint, /\.screenshots\//)
  for (const why of IMAGE_UNAVAILABLE) {
    const t = imageUnavailableText(why, 'a.png')
    assert.ok(t.label && t.hint, why)
    assert.doesNotMatch(t.hint, /\n/, 'ツールチップの 1 行')
  }
  assert.equal(new Set(IMAGE_UNAVAILABLE.map((w) => imageUnavailableText(w, 'a.png').label)).size, IMAGE_UNAVAILABLE.length, '区分ごとに別の文')
})
