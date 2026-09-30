// Codex の画像生成で作った画像（#575）。本物の createApp に一時の feed dir・Codex の sessions・generated_images を渡して、
// rollout の item_completed（image_gen.generation / ImageView）に出てきた、そのスレッドの置き場の画像だけが一覧に並び、
// 一覧の鍵でだけ配られ、置き場の外・言及の無いファイル・画像でない中身は配られないことを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { ProgressReader } from './local/progress.ts'
import { Approvals } from './approvals/approvals.ts'
import { UsageStore } from './local/usage.ts'
import { CodexImages, imageMention } from './local/codexImages.ts'
import type { GalleryResponse } from '../shared/types.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 2])
const THREAD = '01a0a98b-21b5-7882-bef1-a87c163322f4'
const ID = `${THREAD}@repo`

let dir: string
let gen: string
let rollout: string
let server: Server
let base: string

const gallery = async (id = ID) => (await (await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/gallery`)).json()) as GalleryResponse
const image = (key: string, id = ID) => fetch(`${base}/api/sessions/${encodeURIComponent(id)}/codex-images/${encodeURIComponent(key)}`)

/** rollout の item_completed の 1 行 */
const completed = (at: Date, item: Record<string, unknown>, turn = 'T1') =>
  JSON.stringify({ timestamp: at.toISOString(), type: 'event_msg', payload: { type: 'item_completed', thread_id: THREAD, turn_id: turn, item } }) + '\n'
/** ターンが閉じた印 */
const turnEnd = (at: Date, turn: string, type = 'task_complete') => JSON.stringify({ timestamp: at.toISOString(), type: 'event_msg', payload: { type, turn_id: turn } }) + '\n'

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-codex-images-'))
  const feedDir = join(dir, 'feed')
  const sessions = join(dir, 'codex', 'sessions')
  gen = join(dir, 'codex', 'generated_images')
  const cwd = join(dir, 'work')
  await mkdir(feedDir)
  await mkdir(cwd)
  const now = new Date()
  const day = now.toISOString().slice(0, 10).split('-')
  const rolloutDir = join(sessions, day[0]!, day[1]!, day[2]!)
  await mkdir(rolloutDir, { recursive: true })
  await mkdir(join(gen, THREAD), { recursive: true })
  await writeFile(join(gen, THREAD, 'exec-gen1.png'), PNG)
  await writeFile(join(gen, THREAD, 'exec-other.png'), PNG) // rollout に出てこない
  await writeFile(join(gen, THREAD, 'exec-svg.png'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await writeFile(join(dir, 'secret.png'), PNG)
  await symlink(join(dir, 'secret.png'), join(gen, THREAD, 'exec-link.png'))
  await writeFile(join(cwd, 'repo-shot.png'), PNG)

  const at = new Date(now.getTime() - 5000)
  rollout = join(rolloutDir, `rollout-2026-09-30T18-00-00-${THREAD}.jsonl`)
  await writeFile(
    rollout,
    JSON.stringify({ timestamp: at.toISOString(), type: 'session_meta', payload: { id: THREAD } }) +
      '\n' +
      completed(at, { type: 'Extension', kind: 'image_gen.generation', id: 'exec-gen1', status: 'completed' }) +
      // 同じ画像を見せた（1 回に数える）
      completed(at, { type: 'ImageView', id: 'exec-v', path: pathToFileURL(join(gen, THREAD, 'exec-gen1.png')).href }) +
      // 置き場の外の画像を見た（配らない）
      completed(at, { type: 'ImageView', id: 'exec-v2', path: pathToFileURL(join(cwd, 'repo-shot.png')).href }) +
      // 中身が画像でない・置き場の外へのリンク（一覧には出るが配らない）
      completed(at, { type: 'Extension', kind: 'image_gen.generation', id: 'exec-svg', status: 'completed' }) +
      completed(at, { type: 'Extension', kind: 'image_gen.generation', id: 'exec-link', status: 'completed' }) +
      // 失敗した生成は数えない
      completed(at, { type: 'Extension', kind: 'image_gen.generation', id: 'exec-other', status: 'failed' }) +
      turnEnd(now, 'T1'),
  )
  const lines = [
    row(now, THREAD, { repo: 'repo', cwd, agent: 'codex', text: '生成しました。', user_text: 'キャラクターを描いて' }),
    row(now, 'far', { repo: 'repo', cwd, agent: 'codex', host: 'far-away-machine', text: '生成しました。' }),
  ]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const app = createApp(
    new FeedStore(feedDir), join(dir, 'dist'), undefined, new Approvals(), undefined, undefined, undefined,
    { tmux: { run: async () => '' }, ps: async () => '', codexImages: new CodexImages(gen) }, undefined, undefined, undefined,
    new UsageStore(sessions, join(dir, 'projects'), feedDir),
    new ProgressReader(join(dir, 'projects'), sessions),
  )
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

test('gallery: rollout に出てきた、そのスレッドの置き場の画像だけを、そのターンの返答のバブルに付ける', async () => {
  const { items } = await gallery()
  const generated = items.filter((i) => i.source === 'generated')
  assert.deepEqual(generated.map((i) => i.url.split('/codex-images/')[1]).sort(), ['exec-gen1.png', 'exec-link.png', 'exec-svg.png'])
  assert.ok(generated.every((i) => i.from === 'agent' && i.ts !== ''), '返答のバブルに付く')
  assert.ok(!items.some((i) => i.url.includes('repo-shot')), '置き場の外の画像は拾わない')
  assert.ok(!items.some((i) => i.url.includes('exec-other')), '言及の無い・失敗した生成は拾わない')
})

test('codex-images: 一覧の鍵でだけ配る。置き場の外へのリンク・画像でない中身・言及の無いファイル・変な鍵は断る', async () => {
  const ok = await image('exec-gen1.png')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG)
  assert.equal((await image('exec-link.png')).status, 404, 'シンボリックリンクで置き場の外へ出ない')
  assert.equal((await image('exec-svg.png')).status, 415, 'SVG は配らない')
  assert.equal((await image('exec-other.png')).status, 404, 'rollout に出てこないファイルは配らない')
  // `..` は fetch が URL を正規化して別の口に向けてしまうので、読み手を直接呼んで見る
  assert.equal(((await new CodexImages(gen).read(rollout, THREAD, '..')) as { status: number }).status, 400)
  assert.equal(((await new CodexImages(gen).read(rollout, '../x', 'exec-gen1.png')) as { status: number }).status, 404, 'スレッドの ID も名前 1 つぶんだけ')
  assert.equal((await fetch(`${base}/api/sessions/${encodeURIComponent(ID)}/codex-images/..%2Fsecret.png`)).status, 400)
})

test('gallery: 別のマシンのセッションは空。rollout が増えたら読み足す', async () => {
  assert.deepEqual((await gallery('far@repo')).items, [])
  await writeFile(join(gen, THREAD, 'exec-gen2.png'), PNG)
  await appendFile(rollout, completed(new Date(), { type: 'Extension', kind: 'image_gen.generation', id: 'exec-gen2', status: 'completed' }))
  const keys = (await gallery()).items.filter((i) => i.source === 'generated').map((i) => i.url.split('/codex-images/')[1])
  assert.ok(keys.includes('exec-gen2.png'))
  assert.equal((await image('exec-gen2.png')).status, 200)
})

test('imageMention: 生成は item id、見せた画像はそのスレッドの置き場の直下のときだけ', () => {
  const threadDir = '/h/.codex/generated_images/T1'
  const ev = (item: Record<string, unknown>) => ({ type: 'event_msg', payload: { type: 'item_completed', item } })
  assert.deepEqual(imageMention(ev({ type: 'Extension', kind: 'image_gen.generation', id: 'exec-1', status: 'completed' }), threadDir), { id: 'exec-1', exact: false })
  assert.equal(imageMention(ev({ type: 'Extension', kind: 'image_gen.generation', id: '../x', status: 'completed' }), threadDir), null)
  assert.deepEqual(imageMention(ev({ type: 'ImageView', path: 'file:///h/.codex/generated_images/T1/a.png' }), threadDir), { id: 'a.png', exact: true })
  assert.equal(imageMention(ev({ type: 'ImageView', path: 'file:///h/.codex/generated_images/T2/a.png' }), threadDir), null, '別のスレッド')
  assert.equal(imageMention(ev({ type: 'ImageView', path: 'file:///h/.codex/generated_images/T1/sub/a.png' }), threadDir), null, '直下だけ')
  assert.equal(imageMention({ type: 'response_item', payload: {} }, threadDir), null)
})

test('gallery: 行を書かずに終わったターン（エラー・止めた）の画像は、次のターンの返答に付けない。閉じていないターンの画像も付けない（#576 のレビュー）', async () => {
  const t0 = new Date(Date.now() + 60_000)
  await writeFile(join(gen, THREAD, 'exec-lost.png'), PNG)
  await writeFile(join(gen, THREAD, 'exec-open.png'), PNG)
  // T2 は画像を作ってから止めて閉じた（行は書かれない）。そのあと別のターンの行が届く。T4 はまだ回っている
  await appendFile(
    rollout,
    completed(t0, { type: 'Extension', kind: 'image_gen.generation', id: 'exec-lost', status: 'completed' }, 'T2') +
      turnEnd(t0, 'T2', 'turn_aborted') +
      completed(new Date(t0.getTime() + 60_000), { type: 'Extension', kind: 'image_gen.generation', id: 'exec-open', status: 'completed' }, 'T4'),
  )
  await appendFile(join(dir, 'feed', `${localDate(t0.toISOString())}.jsonl`), JSON.stringify(row(new Date(t0.getTime() + 30_000), THREAD, { repo: 'repo', cwd: join(dir, 'work'), agent: 'codex', text: '次のターン' })) + '\n')
  const items = (await gallery()).items
  const lost = items.find((i) => i.url.endsWith('exec-lost.png'))
  assert.ok(lost, '一覧には出る（配れる）')
  assert.equal(lost.ts, '', '次のターンの返答には付けない')
  assert.equal(items.find((i) => i.url.endsWith('exec-open.png'))?.ts, '', 'まだ閉じていないターンの画像は付けない')
  assert.notEqual(items.find((i) => i.url.endsWith('exec-gen1.png'))?.ts, '', '閉じたターンの画像は今までどおり付く')
})
