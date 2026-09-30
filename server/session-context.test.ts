// セッションの詳細にいまのコンテキスト量を載せる（#441）。本物の createApp に偽の ProgressReader を渡して、
// 分かるセッションにだけ載ること・別のマシンのセッションには載せないこと・丸めた値が rev に混ざることを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { ProgressReader } from './local/progress.ts'
import { Approvals } from './approvals/approvals.ts'
import { UsageStore } from './local/usage.ts'
import type { SessionDetailResponse, SessionProgressResponse } from '../shared/types.ts'

/** セッションごとに決めた量を返す偽物（本物は ~/.claude と ~/.codex を読む） */
const sizes = new Map<string, number>([['S1@repo', 830_000], ['S2@repo', 900_000], ['S3@repo', 0]])
class FakeProgress extends ProgressReader {
  override async read(s: { id: string }): Promise<SessionProgressResponse> {
    return { rev: '', id: s.id, active: false, steps: [], total: 0, updated_at: '', context_tokens: sizes.get(s.id) ?? 0 }
  }
}

let dir: string
let server: Server
let base: string
const detail = async (id: string) => (await (await fetch(`${base}/api/sessions/${encodeURIComponent(id)}`)).json()) as SessionDetailResponse

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-context-'))
  const feedDir = join(dir, 'feed')
  await mkdir(feedDir)
  const now = new Date()
  const lines = [
    row(now, 'S1', { repo: 'repo', cwd: dir, agent: 'claude' }),
    row(now, 'S2', { repo: 'repo', cwd: dir, agent: 'claude', host: 'far-away-machine' }),
    row(now, 'S3', { repo: 'repo', cwd: dir, agent: 'codex' }),
  ]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const app = createApp(
    new FeedStore(feedDir), join(dir, 'dist'), undefined, new Approvals(), undefined, undefined, undefined,
    { tmux: { run: async () => '' }, ps: async () => '' }, undefined, undefined, undefined,
    new UsageStore(join(dir, 'codex'), join(dir, 'projects'), feedDir),
    new FakeProgress(join(dir, 'projects'), join(dir, 'codex')),
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

test('詳細にいまのコンテキスト量が載る。分からない（0）ときと別のマシンのセッションには載せない', async () => {
  assert.equal((await detail('S1@repo')).context_tokens, 830_000)
  assert.equal('context_tokens' in (await detail('S3@repo')), false, '0 は載せない')
  assert.equal('context_tokens' in (await detail('S2@repo')), false, '別のマシンのセッションは手元の量ではない')
})

test('量が 1 万以上動いたら rev が変わる（画面が描き直す）。1 万未満の増減では変わらない', async () => {
  const first = (await detail('S1@repo')).rev
  sizes.set('S1@repo', 834_000)
  assert.equal((await detail('S1@repo')).rev, first, 'ターンの途中の少しの増減では描き直さない')
  sizes.set('S1@repo', 850_000)
  assert.notEqual((await detail('S1@repo')).rev, first)
})
