import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ICON_ACCEPT, iconUrl, sniffImageType } from './icon.ts'

test('sniffImageType: 先頭のバイト列で PNG / JPEG / GIF / WebP を見分ける', () => {
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png')
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00])), 'jpeg')
  assert.equal(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'gif')
  assert.equal(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])), 'webp')
  assert.equal(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45])), null, 'RIFF でも WAVE は違う')
  assert.equal(sniffImageType(new Uint8Array([0x3c, 0x73, 0x76, 0x67])), null, 'SVG は受けない（スクリプトが入る）')
  assert.equal(sniffImageType(new Uint8Array([])), null)
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50])), null, '短すぎる')
})

test('iconUrl: id と version をエンコードする', () => {
  assert.equal(iconUrl('s1@sai', '123.5'), '/api/sessions/s1%40sai/icon?v=123.5')
  assert.equal(iconUrl('a b', 'x/y'), '/api/sessions/a%20b/icon?v=x%2Fy')
  assert.equal(ICON_ACCEPT, 'image/png,image/jpeg,image/gif,image/webp')
})
