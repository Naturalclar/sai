import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bareImagePaths, galleryFromRows, GALLERY_MAX, mergeGallery, rowTsAtOrAfter, userImageSrcs } from './gallery.ts'
import { sessionImageUrl } from './images.ts'
import type { FeedRow, GalleryItem } from './types.ts'

const row = (ts: string, fields: Partial<FeedRow>): FeedRow => ({ ts, session: 'S', repo: 'r', agent: 'claude', event: 'Stop', text: '', ...fields }) as FeedRow

test('bareImagePaths: 地の文の画像の絶対パスだけ。末尾の句読点は落とし、画像でない拡張子・相対パスは拾わない', () => {
  assert.deepEqual(bareImagePaths('この画像の色を答えて: /private/tmp/a/x.png'), ['/private/tmp/a/x.png'])
  assert.deepEqual(bareImagePaths('見て /Users/me/shot.JPG。それと「/Users/me/b.webp」'), ['/Users/me/shot.JPG', '/Users/me/b.webp'])
  assert.deepEqual(bareImagePaths('/Users/me/notes.md と docs/a.png と /Users/me/c.svg'), [], 'md・相対・svg は拾わない')
  assert.deepEqual(bareImagePaths('/a/x.png /a/x.png'), ['/a/x.png'], '同じものは 1 つ')
  assert.deepEqual(bareImagePaths('参考: https://example.com/a/b.png と //host/c.png'), [], 'URL の // 以降をパスと取り違えない')
})

test('userImageSrcs: Markdown の画像と地の文のパス。SAI の添付（見出しの下）は別口なので入れない', () => {
  const text = '![u](docs/typed.png) と /Users/me/shot.png\n\n添付した画像:\n/Users/me/.agent-feed/attachments/0123456789abcdef/fedcba9876543210.png'
  assert.deepEqual(userImageSrcs(text), ['docs/typed.png', '/Users/me/shot.png'])
})

test('galleryFromRows: 返答・自分の入力・添付を拾い、新しい順・同じ画像は最初に出た発言に 1 つ。待ちの行は見ない', () => {
  const rows = [
    row('2026-09-28T10:00:00+09:00', { event: 'UserPromptSubmit', user_text: '[Image #1] と /Users/me/shot.png\n\n添付した画像:\n/Users/me/.agent-feed/attachments/0123456789abcdef/fedcba9876543210.png' }),
    row('2026-09-28T10:00:05+09:00', { text: 'できた ![icon](docs/icon.png)', user_text: '[Image #1] と /Users/me/shot.png' }),
    row('2026-09-28T10:01:00+09:00', { event: 'PermissionRequest', text: '許可待ち: Read: /Users/me/wait.png' }),
  ]
  const items = galleryFromRows('S@r', rows)
  assert.deepEqual(
    items.map((i) => [i.name, i.from, i.source, i.ts]),
    [
      ['icon', 'agent', 'text', '2026-09-28T10:00:05+09:00'],
      ['fedcba9876543210.png', 'user', 'attachment', '2026-09-28T10:00:00+09:00'],
      ['shot.png', 'user', 'text', '2026-09-28T10:00:00+09:00'],
    ],
  )
  assert.equal(items[2]!.url, sessionImageUrl('S@r', '/Users/me/shot.png'))
  assert.match(items[1]!.url, /^\/api\/attachments\//)
})

test('mergeGallery: 上限で切る', () => {
  const many: GalleryItem[] = Array.from({ length: GALLERY_MAX + 5 }, (_, i) => ({ url: `/u${i}`, name: '', at: new Date(i * 1000).toISOString(), ts: '', from: 'user', source: 'text' }))
  const out = mergeGallery(many)
  assert.equal(out.length, GALLERY_MAX)
  assert.equal(out[0]!.url, `/u${GALLERY_MAX + 4}`, '新しいものから')
})

test('rowTsAtOrAfter: 画像の時刻の秒以降で一番古い行（貼った画像は入力の行、Read の画像はそのターンの完了の行）', () => {
  const rows = [row('2026-09-28T10:00:00+09:00', {}), row('2026-09-28T10:00:05+09:00', {}), row('2026-09-28T10:02:00+09:00', {})]
  assert.equal(rowTsAtOrAfter(rows, '2026-09-28T01:00:05.400Z'), '2026-09-28T10:00:05+09:00', '同じ秒の行（ミリ秒は落として比べる）')
  assert.equal(rowTsAtOrAfter(rows, '2026-09-28T01:00:30.000Z'), '2026-09-28T10:02:00+09:00')
  assert.equal(rowTsAtOrAfter(rows, '2026-09-28T02:00:00.000Z'), '', 'あとに行が無ければ空')
  const withOther = [row('2026-09-28T10:00:05+09:00', { event: 'SubagentStop' }), row('2026-09-28T10:00:06+09:00', { event: 'Notification', text: '入力待ち' }), row('2026-09-28T10:00:09+09:00', {})]
  assert.equal(rowTsAtOrAfter(withOther, '2026-09-28T01:00:05.000Z'), '2026-09-28T10:00:09+09:00', '発言として出ない行（SubagentStop・入力待ち）には飛ばさない')
})
