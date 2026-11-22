import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalAction, askEnterAction, denyDecision, denyKey, hotkeyApplies, hotkeyAppliesAt, optionIndex } from './approvalKeys.ts'
import { navAction } from './sessionNav.ts'
import { paneKey } from './paneKeys.ts'
import { blursOnEscape, leavesToSidebar } from './replyFocus.ts'

const key = (over: Partial<Parameters<typeof approvalAction>[0]> = {}) => ({
  key: 'Enter',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...over,
})

test('approvalAction: ⌘Enter で許可、⌘⇧Enter で常に許可', () => {
  assert.equal(approvalAction(key({ metaKey: true }), true), 'allow')
  assert.equal(approvalAction(key({ metaKey: true, shiftKey: true }), true), 'always')
})

test('approvalAction: Windows / Linux の Ctrl+Enter も同じ', () => {
  assert.equal(approvalAction(key({ ctrlKey: true }), true), 'allow')
  assert.equal(approvalAction(key({ ctrlKey: true, shiftKey: true }), true), 'always')
})

test('approvalAction: 「常に許可」が無いバブルでは ⌘⇧Enter も許可に落ちる', () => {
  assert.equal(approvalAction(key({ metaKey: true, shiftKey: true }), false), 'allow')
  assert.equal(approvalAction(key({ metaKey: true }), false), 'allow')
})

test('approvalAction: 素の Enter は触らない（入力欄の送信）', () => {
  assert.equal(approvalAction(key(), true), null)
  assert.equal(approvalAction(key({ shiftKey: true }), true), null, '⇧Enter は改行')
})

test('approvalAction: IME 変換中・Alt 付き・Enter 以外は何もしない', () => {
  assert.equal(approvalAction(key({ metaKey: true, isComposing: true }), true), null)
  assert.equal(approvalAction(key({ metaKey: true, altKey: true }), true), null)
  assert.equal(approvalAction(key({ metaKey: true, shiftKey: true, altKey: true }), true), null)
  assert.equal(approvalAction(key({ key: 'a', metaKey: true }), true), null)
  assert.equal(approvalAction(key({ key: 'Escape', metaKey: true }), true), null)
})

test('hotkeyApplies: モーダルの中・フォーカスの無いペインの中で押した ⌘Enter は許可に使わない（#633）', () => {
  assert.equal(hotkeyApplies(null, 'a@repo', true), false)
  assert.equal(hotkeyApplies('a@repo', 'a@repo', true), false)
  assert.equal(hotkeyApplies(null, 'a@repo', false), true)
})

test('hotkeyApplies: 別のセッションの返信欄で押した ⌘Enter は許可に使わない（要対応の行の下の返信欄）', () => {
  // 印の無い場所（セッション画面の入力欄・本文）は今までどおり
  assert.equal(hotkeyApplies(null, 'a@repo'), true)
  // 同じセッションの返信欄
  assert.equal(hotkeyApplies('a@repo', 'a@repo'), true)
  // 別のセッションの返信欄では、その返信欄の送信に任せる
  assert.equal(hotkeyApplies('b@repo', 'a@repo'), false)
})

test('denyKey: ⌘. / Ctrl+. で拒否（#909）', () => {
  assert.equal(denyKey(key({ key: '.', metaKey: true })), true)
  assert.equal(denyKey(key({ key: '.', ctrlKey: true })), true)
})

test('denyKey: 素の . ・⇧ / Alt 付き・IME 変換中・ほかのキーは何もしない', () => {
  assert.equal(denyKey(key({ key: '.' })), false, '入力欄の句点')
  assert.equal(denyKey(key({ key: '.', metaKey: true, shiftKey: true })), false)
  assert.equal(denyKey(key({ key: '.', metaKey: true, altKey: true })), false)
  assert.equal(denyKey(key({ key: '.', metaKey: true, isComposing: true })), false)
  assert.equal(denyKey(key({ key: 'Backspace', metaKey: true })), false, '⌘⌫ は行頭まで消す')
  assert.equal(denyKey(key({ metaKey: true })), false, '⌘Enter は許可')
})

test('denyDecision: 今回だけの拒否を 1 つ選ぶ。「今後も断る」は押さない', () => {
  const allow = { id: 'a', label: '許可', behavior: 'allow' as const }
  const decline = { id: 'd', label: '拒否', behavior: 'deny' as const }
  const cancel = { id: 'c', label: 'ターンを中止', behavior: 'deny' as const }
  const forever = { id: 'f', label: '今後も断る', behavior: 'deny' as const, persists: true as const }
  assert.equal(denyDecision([allow, decline, cancel]), 'd', '「拒否」と「ターンを中止」なら「拒否」')
  assert.equal(denyDecision([allow, { id: 'n', label: 'No, and tell Codex', behavior: 'deny' }]), 'n', '今回だけの拒否が 1 つならそれ')
  assert.equal(denyDecision([allow, forever]), null, '残る拒否しか無ければキーでは押さない')
  assert.equal(denyDecision([allow, cancel, { id: 'n', label: 'No', behavior: 'deny' }]), null, '決められなければ押さない')
  assert.equal(denyDecision([allow]), null)
})

test('optionIndex: 入力欄の外で 1〜9 → その選択肢（#909）', () => {
  assert.equal(optionIndex(key({ key: '1' }), 3, false), 0)
  assert.equal(optionIndex(key({ key: '3' }), 3, false), 2)
  assert.equal(optionIndex(key({ key: '4' }), 3, false), null, '範囲の外')
  assert.equal(optionIndex(key({ key: '0' }), 10, false), null)
  assert.equal(optionIndex(key({ key: '1' }), 3, true), null, '入力欄の数字は文字のまま')
  assert.equal(optionIndex(key({ key: '1', ctrlKey: true }), 3, false), null, 'Ctrl+1 はペインのキー')
  assert.equal(optionIndex(key({ key: '1', metaKey: true }), 3, false), null)
  assert.equal(optionIndex(key({ key: '1', isComposing: true }), 3, false), null)
  assert.equal(optionIndex(key({ key: 'j' }), 3, false), null)
})

test('askEnterAction: 全部そろうまで送らない', () => {
  assert.equal(askEnterAction(false, false, false), null, 'いまの問いに答えが無ければ進まない')
  assert.equal(askEnterAction(false, true, false), 'next')
  assert.equal(askEnterAction(true, true, false), null, '最後でも欠けがあれば送らない')
  assert.equal(askEnterAction(true, true, true), 'send')
})

test('hotkeyAppliesAt: 別のセッションの返信欄・モーダル・フォーカスの無いペインでは受けない', () => {
  const place = (hits: Record<string, { reply?: string; focused?: boolean }>) => ({
    closest: (selector: string) => {
      const hit = hits[selector]
      if (!hit) return null
      return { getAttribute: () => hit.reply ?? null, classList: { contains: (name: string) => name === 'focused' && hit.focused === true } }
    },
  })
  assert.equal(hotkeyAppliesAt(null, 'e1'), true)
  assert.equal(hotkeyAppliesAt(place({}), 'e1'), true, 'サイドバー・body など')
  assert.equal(hotkeyAppliesAt(place({ '[data-reply-for]': { reply: 'e2' } }), 'e1'), false)
  assert.equal(hotkeyAppliesAt(place({ '[data-reply-for]': { reply: 'e1' } }), 'e1'), true)
  assert.equal(hotkeyAppliesAt(place({ '[role="dialog"]': {} }), 'e1'), false)
  assert.equal(hotkeyAppliesAt(place({ '.pane': { focused: false } }), 'e1'), false)
  assert.equal(hotkeyAppliesAt(place({ '.pane': { focused: true } }), 'e1'), true)
})

test('新しいキーは一覧・ペイン・入力欄のキーと当たらない（#909）', () => {
  const keys = [
    key({ key: '.', metaKey: true }),
    key({ key: '.', ctrlKey: true }),
    ...'123456789'.split('').map((k) => key({ key: k })),
  ]
  for (const k of keys) {
    assert.equal(navAction(k), null, `一覧: ${k.key}`)
    assert.equal(paneKey(k, false), null, `ペイン: ${k.key}`)
    assert.equal(approvalAction(k, true), null, `許可: ${k.key}`)
    assert.equal(blursOnEscape(k, { menuOpen: false }), false)
    assert.equal(leavesToSidebar(k, { text: '', menuOpen: false }), false)
  }
})
