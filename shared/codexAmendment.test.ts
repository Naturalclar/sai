import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AMENDMENT_LABEL_WIDTH, amendmentLabel, amendmentScope } from './codexAmendment.ts'

test('規則の追加の範囲: 語の並びをそのまま 1 行にする。シェルに包まれたものは中身（#741）', () => {
  // 0.160.1 で実測した 3 つの形
  assert.deepEqual(amendmentScope(['curl', '-sI', 'https://example.com', '-o', '/dev/null']), { text: 'curl -sI https://example.com -o /dev/null' })
  assert.deepEqual(amendmentScope(['/bin/zsh', '-lc', 'touch ~/x/a.txt']), { text: 'touch ~/x/a.txt' })
  assert.deepEqual(amendmentScope(['/bin/zsh', '-lc', 'ls ~/x | wc -l && date > ~/x/c.txt']), { text: 'ls ~/x | wc -l && date > ~/x/c.txt' })
  assert.deepEqual(amendmentScope(['git', 'status']), { text: 'git status' })
  assert.deepEqual(amendmentScope(['ls']), { text: 'ls' }, '1 語でも、広くないコマンドは出す')
  assert.deepEqual(amendmentScope(['echo', 'a b']), { text: 'echo "a b"' }, '空白を含む語は引用符で囲む（語の切れ目が見えるように）')
  assert.equal(amendmentLabel(['git', 'status']), '「git status」を今後聞かない')
})

test('規則の追加の範囲: 改行は空白にし、長いものは幅で切る', () => {
  assert.deepEqual(amendmentScope(['bash', '-c', 'cd /repo\npnpm test']), { text: 'cd /repo pnpm test' })
  const long = amendmentScope(['/bin/zsh', '-lc', 'echo ' + 'あ'.repeat(60)])!
  assert.ok(long.text.endsWith('…'))
  assert.ok([...long.text].reduce((w, ch) => w + (ch.codePointAt(0)! >= 0x1100 ? 2 : 1), 0) <= AMENDMENT_LABEL_WIDTH)
})

test('規則の追加の範囲: 読めない・広すぎる提案はボタンにしない', () => {
  for (const pattern of [undefined, null, '', 'git status', [], [''], ['git', 1], ['git', '  '], { 0: 'git' }]) {
    assert.equal(amendmentScope(pattern), null, JSON.stringify(pattern))
    assert.equal(amendmentLabel(pattern), null)
  }
  // シェルだけ（実行する中身が付いていない）
  for (const pattern of [['bash'], ['/bin/zsh', '-lc'], ['sh', '-c'], ['zsh', 'script.sh'], ['/bin/zsh', '-l', 'x']]) assert.equal(amendmentScope(pattern), null, pattern.join(' '))
  // 1 語だけで広すぎる: インタプリタ・rm など、サブコマンドを持つ CLI
  for (const word of ['python3', 'node', 'rm', 'env', 'xargs', 'curl', 'git', 'gh', 'pnpm', 'docker', '/usr/bin/git']) assert.equal(amendmentScope([word]), null, word)
  // 権限を上げる語で始まる
  assert.equal(amendmentScope(['sudo', 'ls', '/root']), null)
  assert.equal(amendmentScope(['/usr/bin/sudo', 'ls']), null)
})
