import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GhPr, NoPr, parsePr, validBranch } from './pr.ts'

/** `gh` の代わりに置く shell スクリプト。呼ばれた引数を記録し、決めた stdout と終了コードを返す */
async function fakeGh(dir: string, body: string): Promise<string> {
  const bin = join(dir, 'gh')
  await writeFile(bin, `#!/bin/sh\necho "$@" >> "${join(dir, 'calls')}"\n${body}\n`)
  await chmod(bin, 0o755)
  return bin
}

test('validBranch: フラグに化けるものと空白入りは断る', () => {
  assert.equal(validBranch('main'), true)
  assert.equal(validBranch('feat/x-1'), true)
  assert.equal(validBranch(''), false)
  assert.equal(validBranch('--json'), false, 'フラグに化ける')
  assert.equal(validBranch('-x'), false)
  assert.equal(validBranch('a b'), false)
  assert.equal(validBranch('a"b'), false)
})

test('parsePr: gh の JSON を読む。番号が無ければ null', () => {
  assert.deepEqual(parsePr('{"isDraft":false,"number":210,"state":"MERGED","url":"https://x/pull/210"}'), {
    number: 210,
    url: 'https://x/pull/210',
    state: 'MERGED',
    draft: false,
  })
  assert.equal(parsePr('{"isDraft":true,"number":7,"state":"OPEN","url":""}')?.draft, true)
  assert.equal(parsePr(''), null, 'gh が失敗したときの空')
  assert.equal(parsePr('no pull requests found for branch "x"'), null, 'JSON でない')
  assert.equal(parsePr('{}'), null, '番号が無い')
  assert.equal(parsePr('[1,2]'), null, 'オブジェクトでない')
})

test('GhPr: gh の出力から PR を引き、同じブランチは引き直さない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-pr-'))
  try {
    const bin = await fakeGh(dir, 'echo \'{"isDraft":false,"number":42,"state":"OPEN","url":"https://x/pull/42"}\'')
    const gh = new GhPr(bin)
    const first = await gh.find(dir, 'feat/x')
    assert.equal(first?.number, 42)
    assert.equal(first?.state, 'OPEN')
    await gh.find(dir, 'feat/x')
    const log = await readFile(join(dir, 'calls'), 'utf8')
    assert.equal(log.trim().split('\n').length, 1, '2 回目はキャッシュから返すので gh は 1 回だけ')
    assert.match(log, /^pr view feat\/x --json number,url,state,isDraft$/m, '組み立てるのは pr view の 1 形だけ')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('GhPr: gh が失敗しても null を返すだけ（差分の表示を落とさない）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-pr-fail-'))
  try {
    const bin = await fakeGh(dir, 'echo "no pull requests found" >&2\nexit 1')
    assert.equal(await new GhPr(bin).find(dir, 'feat/x'), null)
    // 実行ファイルが無い（gh を入れていない）
    assert.equal(await new GhPr(join(dir, 'does-not-exist')).find(dir, 'feat/x'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('GhPr: 時間切れなら諦める（要約を待たせない）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-pr-slow-'))
  try {
    const bin = await fakeGh(dir, 'sleep 30')
    const started = Date.now()
    assert.equal(await new GhPr(bin, 60_000, 150).find(dir, 'feat/x'), null)
    assert.ok(Date.now() - started < 5000, 'timeout で切り上げる')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('GhPr: ブランチ名が無い（detached）・cwd が空なら gh を呼ばない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-pr-skip-'))
  try {
    const bin = await fakeGh(dir, 'echo \'{"number":1,"state":"OPEN","url":"","isDraft":false}\'')
    const gh = new GhPr(bin)
    assert.equal(await gh.find(dir, ''), null)
    assert.equal(await gh.find(dir, '--json'), null)
    assert.equal(await gh.find('', 'main'), null)
    await assert.rejects(readFile(join(dir, 'calls')), /ENOENT/, 'gh は一度も呼ばれていない')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('NoPr: SAI_GH=0 のときの実装は常に null', async () => {
  assert.equal(await new NoPr().find('/tmp', 'main'), null)
})
