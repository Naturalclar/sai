// 返信に画像以外のファイル（文字のファイル・PDF）も添える（#608）。本物の createApp を叩いて、
// 中身での判定・置き場・本文への足し方・画像だけを受ける口へ渡すもの・配る口（画像だけ）を見る。
// 本物の ~/.agent-feed は触らない
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttachmentResponse, Replying } from '../shared/types.ts'
import { ATTACHMENT_MAX_COUNT, splitAttachments } from '../shared/attachments.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { Authenticator } from './auth.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import { ProgressReader } from './local/progress.ts'
import type { CodexApp } from './reply/codexAppServer.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'
import { ATTACHMENTS_STRIPPED_MARK, AttachmentStore, attachmentDir } from './reply/attachments.ts'
import { JPEG_STRIPPED, JPEG_UNREADABLE, JPEG_WITH_EXIF, PNG_STRIPPED, WEBP_STRIPPED, WEBP_WITH_EXIF } from './local/imageMetadata.test.ts'
import { UNREADABLE_IMAGE_REASON } from './local/imageMetadata.ts'
import { ATTACHMENT_WORK_STALE_MS } from './reply/attachments.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'

let dir: string
/** セッションの cwd（記録の置き場とは別にする。置き場を cwd にした行は SAI 自身の雑音として読まれない） */
let work: string
let server: Server
let base: string

class FakeRunner implements Runner {
  started: { id: string; cmd: ReplyCommand }[] = []
  running() {
    return false
  }
  snapshot(): Record<string, Replying> {
    return {}
  }
  async start(id: string, cmd: ReplyCommand) {
    this.started.push({ id, cmd })
  }
}
const runner = new FakeRunner()
const codexStarted: { text: string; attachments?: readonly string[] }[] = []
const codexApp: CodexApp = {
  running: () => false,
  replying: () => ({}),
  snapshot: () => ({}),
  getApproval: () => undefined,
  async start(o: { text: string; attachments?: readonly string[] }) {
    codexStarted.push(o)
  },
  answer: () => ({ ok: false, status: 404, error: 'approval not found' }),
} as unknown as CodexApp

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') // 1x1。形が読めない作り物は put が断る（#791）
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n')
const LOG = Buffer.from('2026-10-02 ERROR 落ちました\n\tat main\n')
const HTML = Buffer.from('<html><script>alert(1)</script></html>')
const BIN = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00])

const upload = async (id: string, bytes: Buffer, name = '', headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/attachments?days=2${name ? `&name=${encodeURIComponent(name)}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: bytes })
  return { status: res.status, body: (await res.json()) as AttachmentResponse & { error?: string } }
}
const reply = (id: string, body: unknown) => fetch(`${base}/api/sessions/${encodeURIComponent(id)}/reply?days=2`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-attach-'))
  work = await mkdtemp(join(tmpdir(), 'sai-attach-work-'))
  const now = new Date()
  await writeFile(
    join(dir, `${localDate(now.toISOString())}.jsonl`),
    [row(now, 'A1', { repo: 'r', cwd: work, project: 'o/r' }), row(now, 'B1', { repo: 'r', cwd: work, project: 'o/r' }), row(now, 'X1', { repo: 'r', cwd: work, project: 'o/r', agent: 'codex', session_source: 'rollout' })].map((r) => JSON.stringify(r)).join('\n') + '\n',
  )
  const app = createApp(
    new FeedStore(dir), join(dir, 'dist'), runner, new Approvals(), new BuildFreshness(join(dir, 'dist'), [], 0), undefined, new Authenticator(async () => null),
    { tmux: { run: async () => { throw new Error('unused') } }, ps: async () => '', codexApp },
    undefined, undefined, undefined, undefined,
    new ProgressReader(join(dir, 'claude-projects'), join(dir, 'codex-sessions')),
  )
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

test('預ける: 中身で判定する。画像・文字のファイル・PDF は通り、バイナリと拡張子だけ偽ったものは断る', async () => {
  const png = await upload('A1@r', PNG, 'shot.png')
  assert.deepEqual([png.status, png.body.kind, png.body.name, png.body.url.startsWith('/api/attachments/')], [200, 'image', '', true])

  const log = await upload('A1@r', LOG, '../../build (1).log')
  assert.deepEqual([log.status, log.body.kind, log.body.name, log.body.url, log.body.size], [200, 'text', 'build (1).log', '', LOG.length])
  assert.match(log.body.path, /\/attachments\/[0-9a-f]{16}\/[0-9a-f]{16}\.txt$/, '名前は中身のハッシュ。元の名前はパスに使わない')
  assert.deepEqual(await readFile(log.body.path), LOG)

  const pdf = await upload('A1@r', PDF, '仕様.txt')
  assert.deepEqual([pdf.status, pdf.body.kind], [200, 'pdf'], '.txt と名乗っても中身が PDF なら PDF')
  assert.match(pdf.body.path, /\.pdf$/)

  const html = await upload('A1@r', HTML, 'page.html')
  assert.deepEqual([html.status, html.body.kind], [200, 'text'])
  assert.match(html.body.path, /\.txt$/, 'HTML / SVG は文字として .txt で置く')

  const fake = await upload('A1@r', BIN, 'notes.txt')
  assert.equal(fake.status, 400, '拡張子だけ偽ったバイナリ')
  assert.match(fake.body.error ?? '', /画像.*文字のファイル.*PDF/)
  assert.equal((await upload('A1@r', Buffer.alloc(0), 'empty.txt')).status, 400)
  assert.equal((await upload('A1@r', LOG, 'x.log', { Origin: 'https://evil.example' })).status, 403, '別オリジンからは預けられない')
  assert.equal((await upload('nope@r', LOG, 'x.log')).status, 404)

  const names = await readdir(join(dir, 'attachments', attachmentDir('A1@r')))
  assert.equal(names.some((n) => /\.(html|svg|log)$/.test(n)), false)
})

test('預ける: 写真の EXIF は置く前に落とす（#791）。名前のハッシュは落とした後の中身から', async () => {
  const res = await upload('A1@r', JPEG_WITH_EXIF, 'photo.jpg')
  assert.equal(res.status, 200)
  assert.deepEqual(await readFile(res.body.path), JPEG_STRIPPED, '置いたものに EXIF は無い')
  assert.equal(res.body.size, JPEG_STRIPPED.length)
  assert.equal(res.body.name, '')
  const again = await upload('A1@r', JPEG_STRIPPED, 'photo.jpg')
  assert.equal(again.body.path, res.body.path, '落とした後と同じ中身なら同じ名前（重複を作らない）')
  const webp = await upload('A1@r', WEBP_WITH_EXIF, 'photo.webp')
  assert.deepEqual(await readFile(webp.body.path), WEBP_STRIPPED, 'WebP も')
})

test('配る口: 前から置いてある（落としていない）原本も、元のまま配るときに落としてから配る（#791 のレビュー）', async () => {
  const sub = join(dir, 'attachments', attachmentDir('A1@r'))
  await mkdir(sub, { recursive: true })
  const name = `${'f'.repeat(16)}.jpeg`
  await writeFile(join(sub, name), JPEG_WITH_EXIF)
  const res = await fetch(`${base}/api/attachments/${attachmentDir('A1@r')}/${name}`)
  assert.equal(res.status, 200)
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG_STRIPPED)
  assert.ok(!(await readdir(sub)).some((n) => n.endsWith('.tmp')), 'put の tmp は残らない')
})

test('預ける: 同じ中身を同時に置いても全部成功し、tmp は残らない（#791 のレビュー）', async () => {
  const store = new AttachmentStore(join(dir, 'attachments'))
  const results = await Promise.all([1, 2, 3].map(() => store.put('A1@r', JPEG_WITH_EXIF, 'same.jpg')))
  assert.deepEqual(results.map((r) => r.error), ['', '', ''])
  assert.equal(new Set(results.map((r) => r.attachment?.path)).size, 1, '同じ名前')
  await store.ready() // 起動時の一括処理（前のテストが置いた落としていない原本を置き直す）の tmp と混ぜない
  const names = await readdir(join(dir, 'attachments', attachmentDir('A1@r')))
  assert.ok(!names.some((n) => n.endsWith('.tmp')), 'tmp は残らない')
})

test('配る口: 元のまま配るときは no-cache + ETag（前に持った GPS 入りの原本を使わせない）。軽い版は immutable のまま', async () => {
  const sub = join(dir, 'attachments', attachmentDir('A1@r'))
  await mkdir(sub, { recursive: true })
  const name = `${'e'.repeat(16)}.jpeg`
  await writeFile(join(sub, name), JPEG_WITH_EXIF)
  const url = `${base}/api/attachments/${attachmentDir('A1@r')}/${name}`
  const res = await fetch(url)
  assert.equal(res.headers.get('cache-control'), 'private, no-cache')
  const etag = res.headers.get('etag')
  assert.match(etag ?? '', /^"a1-e{16}"$/, '名前と落とし方の版から')
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG_STRIPPED)
  assert.equal((await fetch(url, { headers: { 'If-None-Match': etag! } })).status, 304)
  await writeFile(join(sub, name), JPEG_STRIPPED)
  assert.equal((await fetch(url, { headers: { 'If-None-Match': etag! } })).status, 304, '落とした後の中身が同じなら ETag も同じ')
})

test('AttachmentStore: 前からある添付の画像から起動時に一度だけ落とす。印があれば読み直さない（#791）', async () => {
  const d = await mkdtemp(join(tmpdir(), 'sai-att-strip-'))
  try {
    const sub = join(d, attachmentDir('S1@r'))
    await mkdir(sub, { recursive: true })
    const gps = join(sub, `${'a'.repeat(16)}.jpeg`)
    const clean = join(sub, `${'b'.repeat(16)}.png`)
    await writeFile(gps, JPEG_WITH_EXIF)
    await writeFile(clean, PNG_STRIPPED)
    await writeFile(join(sub, `${'c'.repeat(16)}.txt`), 'not an image')
    assert.deepEqual(await new AttachmentStore(d).ready(), { checked: 2, changed: 1, removed: 0, marked: true })
    assert.deepEqual(await readFile(gps), JPEG_STRIPPED, '名前はそのまま、中身だけ落ちる')
    assert.deepEqual(await readFile(clean), PNG_STRIPPED)
    assert.ok(!(await readdir(sub)).some((n) => n.endsWith('.tmp')), 'tmp は残らない')
    await writeFile(gps, JPEG_WITH_EXIF)
    assert.deepEqual(await new AttachmentStore(d).ready(), { checked: 0, changed: 0, removed: 0, marked: true }, '印があれば何もしない')
    assert.deepEqual(await new AttachmentStore(join(d, 'none')).ready(), { checked: 0, changed: 0, removed: 0, marked: false }, '置き場が無ければ何もしない（最初の put が作る）')
  } finally {
    await rm(d, { recursive: true, force: true })
  }
})

test('配る口は画像だけ（文字のファイル・PDF・元の名前のファイルは返さない）', async () => {
  const png = await upload('A1@r', PNG)
  const log = await upload('A1@r', HTML, 'page.html')
  assert.equal((await fetch(`${base}${png.body.url}`)).status, 200)
  const d = attachmentDir('A1@r')
  const file = log.body.path.split('/').pop()!
  for (const name of [file, `${file}.name`, file.replace('.txt', '.html')]) assert.equal((await fetch(`${base}/api/attachments/${d}/${name}`)).status, 404, name)
})

test('返信: 本文の末尾に画像とファイルを別の見出しで足す。画像だけを受ける口には画像しか渡さない', async () => {
  const png = await upload('A1@r', PNG)
  const log = await upload('A1@r', LOG, 'build.log')
  const pdf = await upload('A1@r', PDF, '仕様.pdf')
  runner.started.length = 0
  assert.equal((await reply('A1@r', { text: 'これ見て', attachments: [png.body.path, log.body.path, pdf.body.path] })).status, 202)
  const sent = runner.started[0]!.cmd.text
  assert.equal(sent, `これ見て\n\n添付した画像:\n${png.body.path}\n\n添付したファイル:\n${log.body.path}（build.log）\n${pdf.body.path}（仕様.pdf）`)
  assert.deepEqual(splitAttachments(sent).files.map((f) => [f.name, f.kind]), [['build.log', 'text'], ['仕様.pdf', 'pdf']])

  // Codex: 画像を受ける口（localImage / -i）には画像だけ。ファイルは本文のパスで渡る
  const xp = await upload('X1@r', PNG)
  const xl = await upload('X1@r', LOG, 'run.log')
  assert.equal((await reply('X1@r', { text: '見て', attachments: [xp.body.path, xl.body.path] })).status, 202)
  assert.deepEqual(codexStarted.at(-1)?.attachments, [xp.body.path])
  assert.ok(codexStarted.at(-1)?.text.includes(`${xl.body.path}（run.log）`))
})

test('返信: 置き場の外・別のセッションの添付・名前の形が違うパス・リンク越しのパス・多すぎる数は 400', async () => {
  const log = await upload('A1@r', LOG, 'build.log')
  const other = await upload('B1@r', LOG, 'build.log')
  const alias = join(dir, 'alias')
  await symlink(join(dir, 'attachments'), alias)
  const viaLink = log.body.path.replace(join(dir, 'attachments'), alias)
  assert.deepEqual(await readFile(viaLink), LOG, 'リンク越しでも同じファイルは読める（が、通さない）')
  runner.started.length = 0
  for (const p of ['/etc/passwd', other.body.path, `${log.body.path}.name`, log.body.path.replace('.txt', '.html'), `${log.body.path}/../../../../etc/passwd`, viaLink]) {
    assert.equal((await reply('A1@r', { text: '見て', attachments: [p] })).status, 400, p)
  }
  assert.equal((await reply('A1@r', { text: '見て', attachments: Array(ATTACHMENT_MAX_COUNT + 1).fill(log.body.path) })).status, 400)
  assert.equal(runner.started.length, 0)
})

test('AttachmentStore.labelOf: 元の名前は隣のファイルから読み、出せる形にして返す。無ければ空', async () => {
  const store = new AttachmentStore(join(dir, 'attachments'))
  const put = await store.put('A1@r', Buffer.from('名前つき\n'), 'a（b）\n.md')
  assert.equal(await store.labelOf(put.attachment!.path), 'ab.md')
  await store.put('A1@r', Buffer.from('名前つき\n'))
  assert.equal(await store.labelOf(put.attachment!.path), '', '同じ中身を名前なしで置き直したら、前の名前は残さない')
  const bare = await store.put('A1@r', Buffer.from('名前なし\n'))
  assert.equal(await store.labelOf(bare.attachment!.path), '')
  assert.equal(store.resolvePath('A1@r', put.attachment!.path), put.attachment!.path)
  assert.equal(store.resolvePath('B1@r', put.attachment!.path), null)
})

test('預ける・配る: 形が読めず落とせたか分からない画像は、置く口が断り、前から置いてあるものは 415 で配らない（4 回目のレビュー）', async () => {
  const res = await upload('A1@r', JPEG_UNREADABLE, 'odd.jpg')
  assert.equal(res.status, 400)
  assert.equal((res.body as unknown as { error: string }).error, UNREADABLE_IMAGE_REASON)
  const sub = join(dir, 'attachments', attachmentDir('A1@r'))
  await mkdir(sub, { recursive: true })
  const name = `${'d'.repeat(16)}.jpeg`
  await writeFile(join(sub, name), JPEG_UNREADABLE)
  const url = `${base}/api/attachments/${attachmentDir('A1@r')}/${name}`
  assert.equal((await fetch(url)).status, 415)
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 415)
})

test('AttachmentStore: 残骸の tmp は起動時に古いものだけ消す。印があっても消す（4 回目のレビュー）', async () => {
  const d = await mkdtemp(join(tmpdir(), 'sai-att-tmp-'))
  try {
    const sub = join(d, attachmentDir('S1@r'))
    await mkdir(sub, { recursive: true })
    const old = join(sub, `${'a'.repeat(16)}.jpeg.123.1.tmp`)
    const oldStrip = join(sub, `${'a'.repeat(16)}.png.123.2.strip.tmp`)
    const fresh = join(sub, `${'b'.repeat(16)}.jpeg.456.1.tmp`)
    for (const f of [old, oldStrip, fresh]) await writeFile(f, 'x')
    await writeFile(join(d, ATTACHMENTS_STRIPPED_MARK), '')
    const t0 = Date.now()
    const now = () => t0 + ATTACHMENT_WORK_STALE_MS + 1000
    await utimes(old, new Date(t0 - 1000), new Date(t0 - 1000))
    await utimes(oldStrip, new Date(t0 - 1000), new Date(t0 - 1000))
    await utimes(fresh, new Date(now() - 1000), new Date(now() - 1000))
    assert.deepEqual(await new AttachmentStore(d, now).ready(), { checked: 0, changed: 0, removed: 2, marked: true })
    assert.deepEqual((await readdir(sub)).sort(), [`${'b'.repeat(16)}.jpeg.456.1.tmp`], '新しい tmp（別の SAI が書いている最中かもしれない）は残す')
  } finally {
    await rm(d, { recursive: true, force: true })
  }
})
