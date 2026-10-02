import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileKey, fileRefOf, fileRefs, isSecretPath, sessionFileUrl } from './files.ts'

test('fileRefOf: 文字のファイルの拡張子で終わるパスだけ。行の指定は最初の行', () => {
  assert.deepEqual(fileRefOf('server/app.ts'), { path: 'server/app.ts', line: 0 })
  assert.deepEqual(fileRefOf('README.md'), { path: 'README.md', line: 0 })
  assert.deepEqual(fileRefOf(' docs/screen.md:12 '), { path: 'docs/screen.md', line: 12 })
  assert.deepEqual(fileRefOf('server/app.ts:461:7'), { path: 'server/app.ts', line: 461 })
  assert.deepEqual(fileRefOf('a/b.py:10-20'), { path: 'a/b.py', line: 10 })
  assert.deepEqual(fileRefOf('a/b.py#L10-L20'), { path: 'a/b.py', line: 10 })
  assert.deepEqual(fileRefOf('/abs/x.json'), { path: '/abs/x.json', line: 0 })
  assert.deepEqual(fileRefOf('app/[id]/(group)/page.tsx'), { path: 'app/[id]/(group)/page.tsx', line: 0 })
  assert.deepEqual(fileRefOf('メモ/計画.md'), { path: 'メモ/計画.md', line: 0 })
  assert.deepEqual(fileRefOf('X.TS'), { path: 'X.TS', line: 0 }, '拡張子の大文字小文字は見ない')
})

test('fileRefOf: コード・URL・拡張子の無いもの・一覧に無い拡張子・画像は拾わない', () => {
  for (const code of [
    'session.turns',
    'store.rows()',
    '127.0.0.1:8787',
    'https://example.com/a.ts',
    'git@github.com:o/r.git',
    'pnpm test && pnpm lint',
    'a b.ts',
    'Makefile',
    'server/reply',
    'server/reply/',
    '.env',
    'config/.env',
    'x.pem',
    'docs/icon.png',
    '*.ts',
    'a//b.ts',
    'C:\\x\\y.ts',
    '',
    `${'a/'.repeat(250)}x.ts`,
  ]) {
    assert.equal(fileRefOf(code), null, code)
  }
})

test('fileRefs: 本文の `コード` から、同じパスは 1 つにして出てきた順に。コードブロックの中は拾わない', () => {
  const text = [
    '`server/app.ts:12` と `server/app.ts:40` を直した。**`docs/screen.md`** も。`store.rows()` は違う',
    '',
    '- 一覧: `web/src/Chat.tsx`',
    '',
    '| ファイル | 件 |',
    '| --- | --- |',
    '| `shared/files.ts` | 1 |',
    '',
    '```',
    '`in/block.ts`',
    '```',
  ].join('\n')
  assert.deepEqual(fileRefs(text), ['server/app.ts', 'docs/screen.md', 'web/src/Chat.tsx', 'shared/files.ts'])
})

test('sessionFileUrl: パスは載せず、鍵だけ（行の指定が違っても同じファイルは同じ鍵）', () => {
  const url = sessionFileUrl('S@r', 'server/app.ts')
  assert.equal(url, `/api/sessions/S%40r/files/${fileKey('server/app.ts')}`)
  assert.ok(!url.includes('app.ts'))
  assert.match(fileKey('server/app.ts'), /^[0-9a-f]{16}$/)
})

test('isSecretPath: 秘密が入っていそうな名前・置き場は断る', () => {
  for (const path of [
    '.env',
    '.env.local',
    'config/.env.production',
    '.ENV',
    'id_rsa',
    'keys/id_ed25519.pub',
    'credentials.json',
    'Credentials',
    'secrets.yaml',
    'secret.txt',
    'server.pem',
    'tls/server.key',
    'x.key.json',
    'store.p12',
    'terraform.tfstate.backup',
    'prod.tfvars',
    '.npmrc',
    'home/.netrc',
    '.git/config',
    'a/.ssh/config',
    '.aws/credentials',
    'gcp-service-account.json',
    // 名前だけで決めるので、秘密の扱いを書いた文書も断る（安全な側に倒す）
    'secrets-handling.md',
  ]) {
    assert.equal(isSecretPath(path), true, path)
  }
  for (const path of ['server/app.ts', 'docs/handling-secrets.md', 'keyboard.ts', 'src/key.ts', 'README.md', 'environment.ts', '.github/workflows/ci.yml', 'identity.ts']) {
    assert.equal(isSecretPath(path), false, path)
  }
})
