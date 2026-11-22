import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SHORTCUT_GROUPS, helpAction, isMacPlatform, keyLabel } from './shortcuts.ts'

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  ...mods,
})
const idle = { typing: false, open: false, modal: false }

test('入力欄の外の ? で開き、もう一度 ? で閉じる', () => {
  assert.equal(helpAction(key('?'), idle), 'toggle')
  assert.equal(helpAction(key('?'), { ...idle, open: true }), 'toggle')
})

test('入力欄の中の ? は文字のまま（開かない）', () => {
  assert.equal(helpAction(key('?'), { ...idle, typing: true }), null)
})

test('開いているときの Esc は閉じるだけ。閉じているときの Esc は触らない（App のフィードへ）', () => {
  assert.equal(helpAction(key('Escape'), { ...idle, open: true }), 'close')
  assert.equal(helpAction(key('Escape'), idle), null)
})

test('修飾キー付き・IME 変換中・ほかのモーダルが出ているときは開かない', () => {
  assert.equal(helpAction(key('?', { metaKey: true }), idle), null)
  assert.equal(helpAction(key('?', { ctrlKey: true }), idle), null)
  assert.equal(helpAction(key('?', { altKey: true }), idle), null)
  assert.equal(helpAction(key('?', { isComposing: true }), idle), null)
  assert.equal(helpAction(key('?'), { ...idle, modal: true }), null)
  assert.equal(helpAction(key('/'), idle), null)
})

test('Mac 以外では ⌘ を Ctrl+、⇧ を Shift+ で見せる', () => {
  assert.equal(keyLabel('⌘K', false), 'Ctrl+K')
  assert.equal(keyLabel('⌘⇧Enter', false), 'Ctrl+Shift+Enter')
  assert.equal(keyLabel('⌘⇧Enter', true), '⌘⇧Enter')
  assert.equal(keyLabel('Ctrl+1〜3', true), 'Ctrl+1〜3')
  assert.equal(isMacPlatform({ platform: 'MacIntel' }), true)
  assert.equal(isMacPlatform({ platform: 'iPhone' }), true)
  assert.equal(isMacPlatform({ userAgentData: { platform: 'Windows' }, platform: 'Win32' }), false)
  assert.equal(isMacPlatform(undefined), false)
})

test('一覧のキーは全部 docs/screen.md に `キー` の形で書いてある（一覧と文書が食い違わない）', () => {
  const doc = readFileSync(resolve(import.meta.dirname, '../../docs/screen.md'), 'utf8')
  const missing = SHORTCUT_GROUPS.flatMap((g) => g.items.flatMap((i) => i.keys)).filter((k) => !doc.includes(`\`${k}\``))
  assert.deepEqual(missing, [])
})
