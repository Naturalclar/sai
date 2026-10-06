// コミット前の一式を短い行だけで返すスクリプト（#688）。偽の pnpm を PATH に置き、通ったら 1 行ずつ・落ちたら落ちた所だけを出し、
// 全文（長い出力）を stdout に流さないことを見る
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/suite.sh', import.meta.url))

/** 偽の pnpm。`FAKE_FAIL` に入っているスクリプトは落ち、どれも長い出力（NOISE が 400 行）を出す */
const FAKE_PNPM = `#!/usr/bin/env bash
name=$2
echo "$name\${3:+ $3}" >> "$FAKE_CALLS"
for i in $(seq 1 400); do echo "NOISE $name $i"; done
bad=0
case ",$FAKE_FAIL," in *",$name,"*) bad=1 ;; esac
case "$name" in
  test)
    if [ $bad = 1 ]; then echo "not ok 7 - 壊れたテスト"; echo "not ok 9 - もう 1 つ"; echo "# tests 12"; echo "# pass 10"; echo "# fail 2"; else echo "# tests 12"; echo "# pass 12"; echo "# fail 0"; fi ;;
  test:feed)
    [ $bad = 1 ] && echo "FAIL: test_x (feed.test_record.RecordTest)"
    echo "Ran 5 tests in 0.1s" ;;
  lint)
    for i in 1 2 3; do echo "web/src/a.ts:$i:1: かぶり [Warning/eslint(no-shadow)]"; done
    [ $bad = 1 ] && echo "web/src/b.ts:9:1: 無い [Error/eslint(no-undef)]" ;;
  typecheck) [ $bad = 1 ] && echo "server/x.ts(1,1): error TS2322: だめ" ;;
esac
exit $bad
`

async function run(fail: string, args: string[] = []): Promise<{ code: number; out: string; calls: string[]; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'sai-suite-test-'))
  await writeFile(join(dir, 'pnpm'), FAKE_PNPM)
  await chmod(join(dir, 'pnpm'), 0o755)
  const calls = join(dir, 'calls')
  const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`, FAKE_FAIL: fail, FAKE_CALLS: calls, TMPDIR: dir }
  const got = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile('bash', [SCRIPT, ...args], { env }, (error, out) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out }))
  })
  return { ...got, calls: (await readFile(calls, 'utf-8')).trim().split('\n'), dir }
}

test('suite.sh: 全部通れば 1 行ずつ。長い出力は流さず、ログも残さない', async () => {
  const got = await run('')
  try {
    assert.equal(got.code, 0)
    assert.deepEqual(got.out.trim().split('\n'), ['test=ok tests=12 pass=12 fail=0', 'test:feed=ok tests=5', 'lint=ok warnings=3 errors=0', 'typecheck=ok', 'status=ok'])
    assert.deepEqual(got.calls, ['test', 'test:feed', 'lint --format=unix', 'typecheck'], 'build は頼まれたときだけ。lint は出力の形を指定する')
    assert.deepEqual((await readdir(got.dir)).filter((n) => n.startsWith('sai-suite.')), [], '通ったらログの置き場を消す')
    assert.ok(!got.out.includes('log='))
  } finally {
    await rm(got.dir, { recursive: true, force: true })
  }
})

test('suite.sh: 落ちたら落ちたテストだけを出し、残りも回して exit 1。全文はログに残す', async () => {
  const got = await run('test,lint,typecheck', ['--build'])
  try {
    assert.equal(got.code, 1)
    assert.deepEqual(got.calls, ['test', 'test:feed', 'lint --format=unix', 'typecheck', 'build'], '落ちても残りを回す')
    assert.ok(!got.out.includes('NOISE'), '長い出力は流さない')
    assert.match(got.out, /^test=fail tests=12 pass=10 fail=2\n {2}not ok 7 - 壊れたテスト\n {2}not ok 9 - もう 1 つ\n/)
    assert.match(got.out, /\nlint=fail warnings=3 errors=1\n {2}web\/src\/b\.ts:9:1: 無い \[Error\/eslint\(no-undef\)\]\n/, '警告は出さず、エラーの行だけ')
    assert.match(got.out, /\ntypecheck=fail\n {2}server\/x\.ts\(1,1\): error TS2322: だめ\n/)
    assert.match(got.out, /\ntest:feed=ok tests=5\n/)
    assert.match(got.out, /\nbuild=ok\n/)
    const log = /\nstatus=fail log=(.+)\n$/.exec(got.out)?.[1]
    assert.ok(log, got.out)
    assert.match(await readFile(join(log, 'test.log'), 'utf-8'), /NOISE test 400/, '全文はログにある')
  } finally {
    await rm(got.dir, { recursive: true, force: true })
  }
})
