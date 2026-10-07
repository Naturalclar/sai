import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOGIN_PANEL_REMEMBER_MS, loginPanelOpen, rememberLoginPanel } from './claudeLoginOpen.ts'

test('loginPanelOpen: 開いたことを 10 分だけ覚える。閉じたら忘れる（古い印で次に勝手に始めない）', () => {
  assert.equal(loginPanelOpen(1000), false)
  rememberLoginPanel(true, 1000)
  assert.equal(loginPanelOpen(1000 + 60_000), true, 'バナーが描き直されても開いたまま')
  assert.equal(loginPanelOpen(1000 + LOGIN_PANEL_REMEMBER_MS), false, '時間切れのあとは開かない')
  rememberLoginPanel(true, 5000)
  rememberLoginPanel(false, 6000)
  assert.equal(loginPanelOpen(6001), false)
})
