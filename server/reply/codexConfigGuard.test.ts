// Codex を起こす前の確かめ（#856）。偽の git と作り物の置き場だけで見る（本物の `~/.codex` には触らない）
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Git } from '../git/diff.ts'
import { CODEX_CONFIG_ALLOWED_FILE, CODEX_CONFIG_MAX_ENTRIES, CODEX_CONFIG_ONCE_MS, CODEX_CONFIG_SHOWN, CodexConfigGuard, scanCodexConfig } from './codexConfigGuard.ts'

let base: string
before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'sai-codex-config-')))
})
after(async () => {
  await rm(base, { recursive: true, force: true })
})

let n = 0
/** 作り物の worktree と、feed dir に当たる置き場 */
async function place() {
  const root = join(base, `case-${++n}`)
  const top = join(root, 'tree')
  const feed = join(root, 'feed')
  await mkdir(join(top, 'sub', 'deep'), { recursive: true })
  await mkdir(feed)
  const asked: string[][] = []
  const git: Git = {
    async run(_cwd, args) {
      asked.push(args)
      return `${top}\n`
    },
  }
  return { top, feed, git, asked, sub: join(top, 'sub'), deep: join(top, 'sub', 'deep') }
}
const put = async (dir: string, name: string, text: string) => {
  await mkdir(join(dir, '.codex'), { recursive: true })
  await writeFile(join(dir, '.codex', name), text)
}

test('cwd が一番上なら何もしない。一番上の .codex も見ない', async () => {
  const p = await place()
  await put(p.top, 'config.toml', 'x')
  assert.equal(await new CodexConfigGuard(p.git, p.feed).check(p.top), null)
  assert.equal(await new CodexConfigGuard(p.git, p.feed).check(p.sub), null, 'サブディレクトリから見ても、一番上の .codex は途中に数えない')
})

test('途中に .codex が無ければ起こす。あれば名前まで返す（中身は返さない）', async () => {
  const p = await place()
  const guard = new CodexConfigGuard(p.git, p.feed)
  assert.equal(await guard.check(p.deep), null)
  await put(p.sub, 'config.toml', '中身の文字')
  const ask = await guard.check(p.deep)
  assert.equal(ask?.reason, 'found')
  assert.deepEqual(ask?.files, [join('sub', '.codex', 'config.toml')])
  assert.ok(!JSON.stringify(ask).includes('中身の文字'))
  assert.notEqual(await guard.check(p.sub), null, 'cwd そのものの .codex も見る')
})

test('cwd より下・横の .codex は見ない', async () => {
  const p = await place()
  await put(p.deep, 'config.toml', 'x')
  await mkdir(join(p.top, 'side'))
  await put(join(p.top, 'side'), 'config.toml', 'x')
  assert.equal(await new CodexConfigGuard(p.git, p.feed).check(p.sub), null)
})

test('このまま起こす: 覚えて、再起動のあとも聞かない。中身が変わったらもう一度聞く', async () => {
  const p = await place()
  await put(p.sub, 'config.toml', 'one')
  const guard = new CodexConfigGuard(p.git, p.feed)
  const ask = await guard.check(p.sub)
  assert.equal(await guard.allow(p.sub, ask!.fingerprint), null)
  assert.equal(await guard.check(p.sub), null)
  assert.equal(await guard.check(p.deep), null, '同じ .codex の下の別の cwd にも効く')
  const again = new CodexConfigGuard(p.git, p.feed)
  assert.equal(await again.check(p.sub), null, '置き場から読み直す')
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(p.feed, CODEX_CONFIG_ALLOWED_FILE), 'utf8'))), [join(p.sub, '.codex')])

  await put(p.sub, 'config.toml', 'two')
  assert.notEqual(await again.check(p.sub), null, '中身が変わった')
  await put(p.sub, 'config.toml', 'one')
  await put(p.sub, 'rules', 'x')
  assert.notEqual(await again.check(p.sub), null, 'ファイルが増えた')
})

test('見せたものと中身が変わっていれば、押しても通さず覚えない', async () => {
  const p = await place()
  await put(p.sub, 'config.toml', 'one')
  const guard = new CodexConfigGuard(p.git, p.feed)
  const ask = await guard.check(p.sub)
  await put(p.sub, 'config.toml', 'two')
  const changed = await guard.allow(p.sub, ask!.fingerprint)
  assert.notEqual(changed, null)
  assert.notEqual(changed?.fingerprint, ask?.fingerprint)
  assert.notEqual(await guard.check(p.sub), null)
})

test('覚えたものが壊れていても、もう一度聞く側に倒す', async () => {
  const p = await place()
  await put(p.sub, 'config.toml', 'x')
  await writeFile(join(p.feed, CODEX_CONFIG_ALLOWED_FILE), '{こわれた')
  assert.notEqual(await new CodexConfigGuard(p.git, p.feed).check(p.sub), null)
})

test('git が読めない → 起こさない。押した分は 1 回だけ、期限つきで効く', async () => {
  const p = await place()
  const broken: Git = { run: () => Promise.reject(new Error('fatal')) }
  let at = 1_000
  const guard = new CodexConfigGuard(broken, p.feed, { now: () => at })
  const ask = await guard.check(p.sub)
  assert.equal(ask?.reason, 'unknown')
  assert.equal(await guard.allow(p.sub, ask!.fingerprint), null)
  assert.equal(await guard.check(p.sub), null, '押した 1 回は通る')
  assert.notEqual(await guard.check(p.sub), null, '2 回目はまた聞く')
  assert.equal(await guard.allow(p.sub, ask!.fingerprint), null)
  at += CODEX_CONFIG_ONCE_MS + 1
  assert.notEqual(await guard.check(p.sub), null, '押したまま期限が過ぎれば効かない')
})

test('git が返らない → 止める', async () => {
  const p = await place()
  const hung: Git = { run: () => new Promise(() => {}) }
  const ask = await new CodexConfigGuard(hung, p.feed, { waitMs: 10 }).check(p.sub)
  assert.equal(ask?.reason, 'unknown')
})

test('cwd が git の一番上の外なら確かめられない', async () => {
  const p = await place()
  const other: Git = { run: async () => `${p.sub}\n` }
  assert.equal((await scanCodexConfig(other, p.top)).kind, 'unknown')
})

test('シンボリックリンク・多すぎる中身は覚えない（押した 1 回だけ）', async () => {
  const p = await place()
  await put(p.sub, 'config.toml', 'x')
  await symlink(join(p.feed, 'elsewhere'), join(p.sub, '.codex', 'rules'))
  const guard = new CodexConfigGuard(p.git, p.feed)
  const ask = await guard.check(p.sub)
  assert.deepEqual(ask?.files, [join('sub', '.codex', 'config.toml'), join('sub', '.codex', 'rules')])
  assert.equal(await guard.allow(p.sub, ask!.fingerprint), null)
  assert.equal(await guard.check(p.sub), null)
  assert.notEqual(await guard.check(p.sub), null)

  const many = await place()
  for (let i = 0; i <= CODEX_CONFIG_MAX_ENTRIES; i++) await put(many.sub, `f${i}`, 'x')
  const scan = await scanCodexConfig(many.git, many.sub)
  assert.equal(scan.kind === 'ok' && scan.dirs[0]?.hash, '')
})

test('.codex がリンク・ファイルでも見つけた扱いにする', async () => {
  const p = await place()
  await symlink(join(p.feed), join(p.sub, '.codex'))
  assert.equal((await new CodexConfigGuard(p.git, p.feed).check(p.sub))?.reason, 'found')
  const q = await place()
  await writeFile(join(q.sub, '.codex'), 'x')
  assert.equal((await new CodexConfigGuard(q.git, q.feed).check(q.sub))?.reason, 'found')
})

test('出す名前は先頭の一部で、残りは数だけ', async () => {
  const p = await place()
  for (let i = 0; i < CODEX_CONFIG_SHOWN + 3; i++) await put(p.sub, `f${String(i).padStart(2, '0')}`, 'x')
  const ask = await new CodexConfigGuard(p.git, p.feed).check(p.sub)
  assert.equal(ask?.files.length, CODEX_CONFIG_SHOWN)
  assert.equal(ask?.more, 3)
})

test('別のリポジトリの中にあるリポジトリは、一番上の .codex も途中として見る', async () => {
  const p = await place()
  const inner = join(p.top, 'inner')
  await mkdir(inner)
  await mkdir(join(p.top, '.git'))
  await put(inner, 'config.toml', 'x')
  const git: Git = { run: async () => `${inner}\n` }
  const ask = await new CodexConfigGuard(git, p.feed).check(inner)
  assert.deepEqual(ask?.files, [join('.codex', 'config.toml')])
})
