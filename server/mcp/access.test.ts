import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MCP_CAP, mcpAccess, normalizeOrigin, parseMcpCaps } from './access.ts'

const sorted = (s: ReadonlySet<string>) => [...s].sort()

test('parseMcpCaps: tools と origins を集める。知らないツール名・Origin の形でない値・形の違う要素は捨てる', () => {
  const caps = {
    [MCP_CAP]: [{ tools: ['read', 'send', 'admin'], origins: ['https://Dash.example.ts.net/', 'javascript:alert(1)', 'https://a.example/path', 1] }, 'x', null, { tools: 'send' }],
    'other.example/cap': [{ tools: ['send'] }],
  }
  const got = parseMcpCaps(caps)
  assert.deepEqual(sorted(got.scopes), ['read', 'send'])
  assert.deepEqual(sorted(got.origins), ['https://dash.example.ts.net'], '小文字・末尾の / を落とす。パス付きは Origin ではない')
  assert.equal(parseMcpCaps({ 'other.example/cap': [{ tools: ['send'] }] }).scopes.size, 0, '別の capability は見ない')
})

test('mcpAccess: ローカルは read だけ。tailnet のユーザーは read が既定で send は capability。タグ付きの端末は capability だけ（#312）', () => {
  assert.deepEqual(sorted(mcpAccess({ kind: 'local' }).scopes), ['read'])

  const user = mcpAccess({ kind: 'tailnet', login: 'me@example.com', caps: {} })
  assert.deepEqual(sorted(user.scopes), ['read'])
  assert.equal(user.caller, 'me@example.com')
  const sender = mcpAccess({ kind: 'tailnet', login: 'me@example.com', caps: { [MCP_CAP]: [{ tools: ['send'], origins: ['https://dash.example.ts.net'] }] } })
  assert.deepEqual(sorted(sender.scopes), ['read', 'send'])
  assert.deepEqual(sorted(sender.origins), ['https://dash.example.ts.net'])

  assert.equal(mcpAccess({ kind: 'tagged', node: 'ci', caps: {} }).scopes.size, 0, 'capability が無ければ何も使えない')
  const ci = mcpAccess({ kind: 'tagged', node: 'ci', caps: { [MCP_CAP]: [{ tools: ['read'] }] } })
  assert.deepEqual(sorted(ci.scopes), ['read'])
  assert.equal(ci.caller, 'タグ付きの端末 ci')
})

test('normalizeOrigin', () => {
  assert.equal(normalizeOrigin('HTTPS://X.example:8443/'), 'https://x.example:8443')
  assert.equal(normalizeOrigin('https://x.example/p'), '')
  assert.equal(normalizeOrigin('null'), '')
})
