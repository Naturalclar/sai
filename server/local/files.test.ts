import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeText, fileTable, isLoopbackHostHeader, readSessionFile } from './files.ts'
import { fileKey } from '../../shared/files.ts'
import { row } from '../rows/aggregate.test.ts'

let dir: string
let cwd: string
let outside: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-files-'))
  cwd = join(dir, 'work')
  outside = join(dir, 'elsewhere')
  await mkdir(join(cwd, 'docs'), { recursive: true })
  await mkdir(join(cwd, 'dir.ts'))
  await mkdir(outside)
  await writeFile(join(cwd, 'docs', 'note.md'), '# 題\n本文\n')
  await writeFile(join(cwd, 'page.html'), '<script>alert(1)</script>')
  await writeFile(join(cwd, 'bin.txt'), Buffer.from([0x68, 0x69, 0x00, 0x01]))
  await writeFile(join(cwd, 'latin1.txt'), Buffer.from([0xe9, 0x74, 0xe9]))
  await writeFile(join(cwd, 'big.log'), 'x'.repeat(2048))
  await writeFile(join(cwd, '.env'), 'TOKEN=abc')
  await writeFile(join(cwd, 'credentials.json'), '{"token":"abc"}')
  await writeFile(join(outside, 'plan.md'), '外の計画')
  await symlink(join(outside, 'plan.md'), join(cwd, 'link.md'))
  await symlink(join(cwd, '.env'), join(cwd, 'settings.txt'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('fileTable: ターン完了の行の本文の `コード` から拾い、鍵で引ける。自分の入力・待ちの行は見ない。同じパスは新しい行の cwd', () => {
  const t = new Date()
  const table = fileTable(
    [
      row(t, 'S', { cwd: '/old', text: '`docs/note.md` を書いた' }),
      row(t, 'S', { event: 'PermissionRequest', text: '許可待ち: Read: `waiting.ts`' }),
      row(t, 'S', { text: 'hi', user_text: '`typed.ts` を見て' }),
      row(t, 'S', { cwd: '/new', text: '`docs/note.md:2` と `store.rows()`' }),
    ],
    '/fallback',
  )
  assert.deepEqual([...table], [[fileKey('docs/note.md'), { src: 'docs/note.md', cwd: '/new' }]])
  assert.equal(fileTable([row(t, 'S', { cwd: '', text: '`a.ts`' })], '/fallback').get(fileKey('a.ts'))?.cwd, '/fallback')
})

test('readSessionFile: cwd の中の文字のファイルを、文字として返す（HTML もただの文字）', async () => {
  const md = await readSessionFile({ src: 'docs/note.md', cwd })
  assert.deepEqual(md, { ok: true, text: '# 題\n本文\n', bytes: Buffer.byteLength('# 題\n本文\n'), name: 'note.md', path: 'docs/note.md' })
  const abs = await readSessionFile({ src: join(cwd, 'docs', 'note.md'), cwd })
  assert.equal(abs.ok, true)
  const html = await readSessionFile({ src: 'page.html', cwd })
  assert.equal(html.ok && html.text, '<script>alert(1)</script>')
})

test('readSessionFile: 無い・cwd の外・リンクで外に出る・ディレクトリ・上限超え・バイナリは、理由を返して中身は返さない', async () => {
  const cases: [string, number][] = [
    ['none.ts', 404],
    ['../elsewhere/plan.md', 403],
    [join(outside, 'plan.md'), 403],
    ['link.md', 403],
    ['dir.ts', 404],
    ['bin.txt', 415],
    ['latin1.txt', 415],
  ]
  for (const [src, status] of cases) {
    const r = await readSessionFile({ src, cwd })
    assert.equal(r.ok, false, src)
    assert.equal(!r.ok && r.status, status, src)
    assert.equal('text' in r, false, src)
  }
  const big = await readSessionFile({ src: 'big.log', cwd }, 1024)
  assert.equal(!big.ok && big.status, 413)
  assert.equal((await readSessionFile({ src: 'big.log', cwd }, 4096)).ok, true)
  assert.equal((await readSessionFile({ src: 'docs/note.md', cwd: '' })).ok, false)
  assert.equal((await readSessionFile({ src: 'docs/note.md', cwd: join(dir, 'gone') })).ok, false)
})

test('readSessionFile: 名前で断るファイルは、書かれた名前でも、リンクを解いた先の名前でも開かない', async () => {
  for (const src of ['.env', 'credentials.json', '.git/config', 'settings.txt']) {
    const r = await readSessionFile({ src, cwd })
    assert.equal(!r.ok && r.status, 403, src)
    assert.equal('text' in r, false, src)
  }
})

test('decodeText: UTF-8 の文字だけ。NUL・壊れたバイト列は null', () => {
  assert.equal(decodeText(Buffer.from('日本語 😀\n')), '日本語 😀\n')
  assert.equal(decodeText(Buffer.alloc(0)), '')
  assert.equal(decodeText(Buffer.from([0x61, 0x00])), null)
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x61])), null)
})

test('isLoopbackHostHeader: ループバックの名前だけ（ポートは問わない）。外の名前・空は断る', () => {
  for (const host of ['127.0.0.1:8787', '127.0.0.1', 'localhost:5173', 'LOCALHOST', '[::1]:8787']) assert.equal(isLoopbackHostHeader(host), true, host)
  for (const host of [undefined, '', 'evil.example.com:8787', '127.0.0.1.evil.example.com', 'mac.tailnet.ts.net', '127.0.0.2', 'localhost.evil.com']) assert.equal(isLoopbackHostHeader(host), false, String(host))
})
