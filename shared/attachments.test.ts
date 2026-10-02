import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachmentLabel, attachmentUrlFromPath, fileSizeLabel, hasBinaryBytes, isFileAttachmentPath, isImageAttachmentPath, isUtf8Text, sniffPdf, splitAttachments, withAttachments } from './attachments.ts'

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
    files: [],
  })
  assert.deepEqual(splitAttachments('ただの本文'), { body: 'ただの本文', urls: [], files: [] })
  // 見出しの後ろに添付でない行があれば、勝手に消さずそのまま出す
  const mixed = `${withAttachments('本文', [A])}\nあとがき`
  assert.deepEqual(splitAttachments(mixed), { body: mixed, urls: [], files: [] })
  // 見出しだけで中身が無い
  assert.deepEqual(splitAttachments('本文\n添付した画像:\n'), { body: '本文\n添付した画像:\n', urls: [], files: [] })
  // 本文の中にたまたま同じ見出しがあっても、最後のものを見る
  const tricky = withAttachments('添付した画像: の話', [A])
  assert.deepEqual(splitAttachments(tricky).body, '添付した画像: の話')
})

const T = `${ROOT}/0123456789abcdef/9999888877776666.txt`
const P = `${ROOT}/0123456789abcdef/5555444433332222.pdf`
const enc = (text: string) => new TextEncoder().encode(text)

test('中身の判定（#608）: 文字と PDF は通る。バイナリ・壊れた UTF-8・空は文字ではない（拡張子は見ない）', () => {
  assert.equal(isUtf8Text(enc('2026-10-02 ERROR 落ちました\n\tat main\r\n\x1b[31m赤\x1b[0m')), true, 'タブ・改行・ESC（色付きのログ）は通す')
  assert.equal(isUtf8Text(enc('<svg onload="alert(1)"></svg>')), true, 'HTML / SVG も文字（保存はするが配らない）')
  assert.equal(isUtf8Text(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false)
  assert.equal(isUtf8Text(new Uint8Array([0x68, 0x69, 0x00, 0x68])), false, 'NUL 入り')
  assert.equal(isUtf8Text(new Uint8Array([0xff, 0xfe, 0x68, 0x00])), false, 'UTF-16')
  assert.equal(isUtf8Text(new Uint8Array([0xe3, 0x81])), false, '途中で切れた UTF-8')
  assert.equal(isUtf8Text(new Uint8Array()), false)
  assert.equal(hasBinaryBytes(enc('ふつうの文')), false)
  assert.equal(sniffPdf(enc('%PDF-1.7\n…')), true)
  assert.equal(sniffPdf(enc('PDF ではない')), false)
})

test('置き場のパスの見分け: 画像と、それ以外のファイル', () => {
  assert.deepEqual([isImageAttachmentPath(A), isFileAttachmentPath(A)], [true, false])
  assert.deepEqual([isImageAttachmentPath(T), isFileAttachmentPath(T)], [false, true])
  assert.equal(isFileAttachmentPath(P), true)
  assert.equal(isFileAttachmentPath(`${ROOT}/0123456789abcdef/9999888877776666.html`), false, '.html / .svg という名前では置かない')
  assert.equal(isFileAttachmentPath('/etc/9999888877776666.txt'), false)
  assert.equal(attachmentUrlFromPath(T), null, '画像以外に配る URL は無い')
})

test('withAttachments / splitAttachments: 画像とファイルの両方で往復する。元の名前は行に添える', () => {
  const names = new Map([[T, 'build (1).log'], [P, '../../仕様（案）.pdf']])
  const text = withAttachments('これ見て', [A, T, P], names)
  assert.equal(text, `これ見て\n\n添付した画像:\n${A}\n\n添付したファイル:\n${T}（build (1).log）\n${P}（仕様案.pdf）`)
  assert.deepEqual(splitAttachments(text), {
    body: 'これ見て',
    urls: ['/api/attachments/0123456789abcdef/aaaabbbbccccdddd.png'],
    files: [{ key: '9999888877776666.txt', name: 'build (1).log', kind: 'text' }, { key: '5555444433332222.pdf', name: '仕様案.pdf', kind: 'pdf' }],
  })
  assert.deepEqual(splitAttachments(withAttachments('', [T])), { body: '', urls: [], files: [{ key: '9999888877776666.txt', name: '', kind: 'text' }] }, '本文が空・名前なしでも外せる')
  assert.deepEqual(splitAttachments(withAttachments('', [A])), { body: '', urls: ['/api/attachments/0123456789abcdef/aaaabbbbccccdddd.png'], files: [] })
  const mixed = `${withAttachments('本文', [T], names)}\n/etc/passwd`
  assert.deepEqual(splitAttachments(mixed), { body: mixed, urls: [], files: [] }, '置き場のファイルでない行が混ざっていれば触らない')
})

test('attachmentLabel / fileSizeLabel', () => {
  assert.equal(attachmentLabel('C:\\logs\\app.log'), 'app.log')
  assert.equal(attachmentLabel('/var/log/sys\nlog（1）.txt'), 'syslog1.txt')
  assert.equal(Array.from(attachmentLabel('あ'.repeat(200))).length, 80)
  assert.equal(attachmentLabel('（）'), '')
  assert.deepEqual([fileSizeLabel(512), fileSizeLabel(1024), fileSizeLabel(15_000), fileSizeLabel(3_500_000)], ['512 B', '1 KB', '15 KB', '3.3 MB'])
})
