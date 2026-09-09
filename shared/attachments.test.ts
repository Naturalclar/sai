import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachmentUrlFromPath, splitAttachments, withAttachments } from './attachments.ts'

const ROOT = '/home/me/.agent-feed/attachments'
const A = `${ROOT}/0123456789abcdef/aaaabbbbccccdddd.png`
const B = `${ROOT}/0123456789abcdef/1111222233334444.jpeg`

test('attachmentUrlFromPath: 置き場の形のパスだけ URL にする', () => {
  assert.equal(attachmentUrlFromPath(A), '/api/attachments/0123456789abcdef/aaaabbbbccccdddd.png')
  // 置き場の場所は問わない（末尾 3 つだけ見る）
  assert.equal(attachmentUrlFromPath('/other/attachments/0123456789abcdef/aaaabbbbccccdddd.png'), '/api/attachments/0123456789abcdef/aaaabbbbccccdddd.png')
  assert.equal(attachmentUrlFromPath('/etc/passwd'), null)
  assert.equal(attachmentUrlFromPath(`${ROOT}/0123456789abcdef/evil.sh`), null, '拡張子が画像でない')
  assert.equal(attachmentUrlFromPath(`${ROOT}/../aaaabbbbccccdddd.png`), null, 'ディレクトリ名がハッシュでない')
  assert.equal(attachmentUrlFromPath(`/nope/0123456789abcdef/aaaabbbbccccdddd.png`), null, '置き場の名前でない')
  assert.equal(attachmentUrlFromPath(''), null)
})

test('withAttachments: 見出しを挟んでパスを1行ずつ足す。無ければ本文だけ', () => {
  assert.equal(withAttachments('  これ見て  ', []), 'これ見て')
  assert.equal(withAttachments('これ見て', [A]), `これ見て\n\n添付した画像:\n${A}`)
  assert.equal(withAttachments('これ見て', [A, B]), `これ見て\n\n添付した画像:\n${A}\n${B}`)
  assert.equal(withAttachments('', [A]), `添付した画像:\n${A}`, '本文が空でも画像だけ送れる')
})

test('splitAttachments: withAttachments の逆。混ざっていれば触らない', () => {
  assert.deepEqual(splitAttachments(withAttachments('これ見て', [A, B])), {
    body: 'これ見て',
    urls: ['/api/attachments/0123456789abcdef/aaaabbbbccccdddd.png', '/api/attachments/0123456789abcdef/1111222233334444.jpeg'],
  })
  assert.deepEqual(splitAttachments('ただの本文'), { body: 'ただの本文', urls: [] })
  // 見出しの後ろに添付でない行があれば、勝手に消さずそのまま出す
  const mixed = `${withAttachments('本文', [A])}\nあとがき`
  assert.deepEqual(splitAttachments(mixed), { body: mixed, urls: [] })
  // 見出しだけで中身が無い
  assert.deepEqual(splitAttachments('本文\n添付した画像:\n'), { body: '本文\n添付した画像:\n', urls: [] })
  // 本文の中にたまたま同じ見出しがあっても、最後のものを見る
  const tricky = withAttachments('添付した画像: の話', [A])
  assert.deepEqual(splitAttachments(tricky).body, '添付した画像: の話')
})
