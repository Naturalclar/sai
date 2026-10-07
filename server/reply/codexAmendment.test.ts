// Codex の「規則の追加」の候補を、範囲を書いたボタンにする（#741）。範囲が書けないものは出さない
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AMENDMENT_RANGE_MAX, AMENDMENT_WORDS_MAX, amendmentLabel, execAmendmentRange, networkAmendmentRange } from './codexAmendment.ts'

const exec = (words: unknown) => ({ acceptWithExecpolicyAmendment: { execpolicy_amendment: words } })
const network = (rule: unknown) => ({ applyNetworkPolicyAmendment: { network_policy_amendment: rule } })

test('コマンドの規則: 語の並びをそのままボタンに書く', () => {
  assert.deepEqual(amendmentLabel(exec(['git', 'status'])), { label: '「git status」を今後聞かない', behavior: 'allow' })
  assert.equal(execAmendmentRange(['curl', '-sI', 'https://example.com']), 'curl -sI https://example.com')
})

test('コマンドの規則: 空白や引用符を含む語は囲んで、語の切れ目が分かるようにする', () => {
  // シェルに包まれた形（実測の形）
  assert.equal(execAmendmentRange(['/bin/zsh', '-lc', 'touch out.txt']), '/bin/zsh -lc "touch out.txt"')
  assert.equal(execAmendmentRange(['echo', 'a "b" c']), 'echo "a \\"b\\" c"')
})

test('コマンドの規則: 読めない形・書き切れない長さは出さない（切って見せない）', () => {
  for (const bad of [undefined, null, 'git status', [], [''], ['git', 3], ['git', ''], ['echo', 'a\nb'], ['echo', 'a\u0007'], ['echo', 'a\u200bb'], ['echo', '「x」']]) {
    assert.equal(execAmendmentRange(bad), null, JSON.stringify(bad))
    assert.equal(amendmentLabel(exec(bad)), null, JSON.stringify(bad))
  }
  assert.equal(execAmendmentRange(['x'.repeat(AMENDMENT_RANGE_MAX)]), 'x'.repeat(AMENDMENT_RANGE_MAX))
  assert.equal(execAmendmentRange(['x'.repeat(AMENDMENT_RANGE_MAX + 1)]), null, '1 文字でも超えたら出さない')
  assert.equal(execAmendmentRange(Array.from({ length: AMENDMENT_WORDS_MAX }, () => 'a'))?.split(' ').length, AMENDMENT_WORDS_MAX)
  assert.equal(execAmendmentRange(Array.from({ length: AMENDMENT_WORDS_MAX + 1 }, () => 'a')), null)
  // 囲みに見える括弧・何も描かれない字・結合文字・半角でない空白（範囲が途中で終わったように見える・1 語が 2 語に見える）
  for (const word of ['status\uFF63だけ', 'a\u3164b', 'a\u2800b', 'e\u0301', 'a\u3000b', 'a\u00a0b', 'a\tb', '『x』']) assert.equal(execAmendmentRange(['git', word]), null, JSON.stringify(word))
  // 中身の欄が無い・名前だけの候補
  assert.equal(amendmentLabel({ acceptWithExecpolicyAmendment: {} }), null)
  assert.equal(amendmentLabel({ acceptWithExecpolicyAmendment: null }), null)
  assert.equal(amendmentLabel('acceptWithExecpolicyAmendment'), null)
})

test('ネットワークの規則: ホストと向き（許す・断る）をボタンに書く', () => {
  assert.deepEqual(amendmentLabel(network({ host: 'example.com', action: 'allow' })), { label: '「example.com」への通信を今後聞かない', behavior: 'allow' })
  assert.deepEqual(amendmentLabel(network({ host: 'example.com', action: 'deny' })), { label: '「example.com」への通信を今後も断る', behavior: 'deny' })
  for (const host of ['*.example.com', 'localhost', '127.0.0.1:8080', '[::1]:443', '::1', 'my_service.internal', 'example.com.']) assert.ok(networkAmendmentRange({ host, action: 'allow' }), host)
})

test('ネットワークの規則: ホストが名前として読めない・向きが分からないものは出さない', () => {
  for (const bad of [undefined, 'example.com', {}, { host: 'example.com' }, { host: 'example.com', action: 'maybe' }, { host: '', action: 'allow' }, { host: 'a b.com', action: 'allow' }, { host: 'https://example.com/x', action: 'allow' }, { host: 'exa\nmple.com', action: 'allow' }, { host: '...', action: 'allow' }, { host: '例.com', action: 'allow' }, { host: `${'a'.repeat(AMENDMENT_RANGE_MAX)}.com`, action: 'allow' }]) {
    assert.equal(amendmentLabel(network(bad)), null, JSON.stringify(bad))
  }
  assert.equal(amendmentLabel('applyNetworkPolicyAmendment'), null)
})

test('候補に、ボタンに書いた範囲のほかのものが載っていたら出さない（押すとまるごと Codex に返る）', () => {
  const both = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] }, applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'allow' } } }
  assert.equal(amendmentLabel(both), null)
  assert.equal(amendmentLabel({ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'], scope: 'global' } }), null)
  assert.equal(amendmentLabel({ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] }, extra: true }), null)
  assert.equal(amendmentLabel({ applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'allow' }, more: 1 } }), null)
  assert.equal(amendmentLabel(network({ host: 'example.com', action: 'allow', port: 22 })), null)
})

test('規則の追加でない候補は undefined（今までどおり名前で出す）', () => {
  for (const other of ['accept', 'acceptForSession', 'decline', 'cancel', { somethingNew: {} }, null, 3]) assert.equal(amendmentLabel(other), undefined, JSON.stringify(other))
})
