import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expandHome, main, parseOptions } from './main.ts'

const ok = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  const r = parseOptions(argv, env)
  assert.equal(r.ok, true, JSON.stringify(r))
  return r.ok ? r.options : (undefined as never)
}
const bad = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  const r = parseOptions(argv, env)
  assert.equal(r.ok, false, JSON.stringify(r))
  return r.ok ? '' : r.error
}

test('parseOptions: 既定と環境変数', () => {
  assert.deepEqual(ok([]), { port: 8787, host: '127.0.0.1', feedDir: join(homedir(), '.agent-feed') })
  assert.equal(ok([], { SAI_PORT: '9000' }).port, 9000)
  assert.equal(ok([], { AGENT_FEED_DIR: '/tmp/feed' }).feedDir, '/tmp/feed')
  assert.equal(ok(['--port', '9001'], { SAI_PORT: '9000' }).port, 9001, '引数が環境変数に勝つ')
  assert.equal(ok(['--feed-dir', '~/x']).feedDir, join(homedir(), 'x'))
  assert.equal(ok(['--host', 'localhost']).host, 'localhost')
})

test('parseOptions: 先頭の -- は落とす（pnpm start -- --port 9000）', () => {
  assert.equal(ok(['--', '--port', '18790', '--feed-dir', '/tmp/x']).port, 18790)
  assert.equal(ok(['--']).port, 8787)
})

test('parseOptions: ポートの検査は引数でも環境変数でも同じ', () => {
  for (const v of ['abc', '0', '65536', '12x', '1.5', '']) {
    assert.match(bad(['--port', v]), /invalid port/, `--port ${v}`)
    assert.match(bad([], { SAI_PORT: v }), /invalid port/, `SAI_PORT=${v}`)
  }
  assert.match(bad([], { SAI_PORT: '-1' }), /invalid port/)
  // `--port -1` は parseArgs が -1 をオプションと見るので文は違うが、同じく1行で断る
  assert.match(bad(['--port', '-1']), /-1|argument missing|usage/)
  assert.equal(ok(['--port', '65535']).port, 65535)
  assert.equal(ok(['--port', '1']).port, 1)
})

test('parseOptions: 外向きの host と知らない引数は1行で断る', () => {
  assert.match(bad(['--host', '0.0.0.0']), /refusing to bind to 0\.0\.0\.0/)
  assert.match(bad(['--nope']), /Unknown option '--nope'[\s\S]*usage: pnpm start/)
  assert.match(bad(['extra']), /Unexpected argument 'extra'[\s\S]*usage: pnpm start/)
  assert.match(bad(['--', '--', '--port', '1']), /Unexpected argument[\s\S]*usage/, '-- は1つだけ落とす')
})

test('main: おかしい引数では例外ではなく exit 2 で、理由を stderr に1行出す', () => {
  const origExit = process.exit
  const origError = console.error
  const errors: string[] = []
  let code: number | undefined
  // process.exit は戻らない前提のコードなので、差し替えでは例外で抜ける
  process.exit = ((c?: number) => {
    code = c
    throw new Error('exit')
  }) as typeof process.exit
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '))
  try {
    assert.throws(() => main(['--port', 'abc']), /^Error: exit$/)
    assert.equal(code, 2)
    assert.equal(errors.length, 1)
    assert.match(errors[0]!, /invalid port: abc/)
    assert.doesNotMatch(errors[0]!, /at .*main\.ts/, 'スタックトレースは出さない')
  } finally {
    process.exit = origExit
    console.error = origError
  }
})

test('expandHome', () => {
  assert.equal(expandHome('~'), homedir())
  assert.equal(expandHome('~/a'), join(homedir(), 'a'))
  assert.equal(expandHome('/abs'), '/abs')
  assert.equal(expandHome('~user/x'), '~user/x')
})
