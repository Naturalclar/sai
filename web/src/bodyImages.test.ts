import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bodyImages, lightboxFrom } from './bodyImages.ts'

const urlOf = (src: string) => `/img/${src.split('/').pop()}`
const TEXT = '撮りました。\n\n![デスクトップ](/w/a.png)\n![モバイル](/w/b.png)\n\n`![コード](/w/c.png)` は拾わない'

test('bodyImages: 同じ発言の本文の画像が、出てきた順に名前つきで並ぶ（#702）', () => {
  assert.deepEqual(bodyImages(TEXT, urlOf), [
    { url: '/img/a.png', name: 'デスクトップ' },
    { url: '/img/b.png', name: 'モバイル' },
  ])
})

test('bodyImages: 名前が無ければファイル名。同じ URL は 1 つ。読めなかったものは入れない', () => {
  assert.deepEqual(bodyImages('![](/w/a.png) と [もう一度](/x/a.png)', urlOf), [{ url: '/img/a.png', name: 'a.png' }])
  assert.deepEqual(bodyImages(TEXT, urlOf, new Set(['/img/a.png'])), [{ url: '/img/b.png', name: 'モバイル' }])
  assert.deepEqual(bodyImages('画像は無い', urlOf), [])
})

test('lightboxFrom: 押した 1 枚が、並びと自分の位置つきで渡る。並びに居なければ自分 1 枚だけ', () => {
  const images = bodyImages(TEXT, urlOf)
  assert.deepEqual(lightboxFrom(images, { url: '/img/b.png', name: 'モバイル' }), { images, index: 1 })
  assert.deepEqual(lightboxFrom(images, { url: '/img/a.png', name: 'デスクトップ' }), { images, index: 0 })
  const alone = { url: '/img/z.png', name: 'z.png' }
  assert.deepEqual(lightboxFrom(images, alone), { images: [alone], index: 0 })
  assert.deepEqual(lightboxFrom([], alone), { images: [alone], index: 0 })
})
