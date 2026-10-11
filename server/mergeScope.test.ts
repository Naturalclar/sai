// 「マージまで」と書かれていても人を待つ PR かを、触ったパスから出すスクリプト（#581）。
// 当たったら必ず止まる側（exit 1）に倒れること・分からないときも止まることを見る
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/merge-scope.sh', import.meta.url))

function run(args: string[], stdin = ''): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // gh を呼ぶ道は PATH を空にして塞ぐ（テストから外に問い合わせない）
    const child = spawn('/bin/bash', [SCRIPT, ...args], { env: { PATH: '/usr/bin:/bin', GH_TOKEN: '', GH_HOST: 'invalid.invalid' } })
    let out = ''
    child.stdout.on('data', (b: Buffer) => (out += b.toString()))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
    child.stdin.end(stdin)
  })
}

test('画面と文書だけの PR は当たらない', async () => {
  const got = await run(['-'], 'web/src/App.tsx\nweb/src/styles.css\ndocs/screen.md\ndocs/history/web.md\nserver/rows/aggregate.ts\n')
  assert.deepEqual(got, { code: 0, out: 'scope=none files=5\n' })
})

test('許可・送信・外に出る口・決まりそのものは、1 つでも当たれば止まる', async () => {
  const guarded = [
    'server/approvals/permissions.ts',
    'shared/bashRules.ts',
    'shared/jev.test.ts',
    'shared/reply.ts',
    'feed/record.py',
    'feed/opencode/sai.js',
    'server/mcp/access.ts',
    'shared/sendAcross.ts',
    'shared/waits.ts',
    '.mcp.json',
    'server/auth.ts',
    'server/app.ts',
    'server/main.ts',
    'server/git/pr.ts',
    'server/digest/digest.ts',
    'server/reply/runner.ts',
    'server/reply/codexDialogs.ts',
    'server/local/claudeLogin.ts',
    '.claude/skills/merge/SKILL.md',
    '.claude/settings.json',
    '.github/workflows/ci.yml',
    'CLAUDE.md',
    'AGENTS.md',
    'scripts/merge-scope.sh',
  ]
  for (const path of guarded) {
    const got = await run(['-'], `web/src/App.tsx\n${path}\n`)
    assert.equal(got.code, 1, path)
    assert.match(got.out, /^scope=hold hits=1\n/, path)
    assert.ok(got.out.includes(`${path} — `), `${path} と理由を出す`)
  }
})

test('当たった数と、当たったパスだけを出す', async () => {
  const got = await run(['-'], 'server/auth.ts\nweb/src/App.tsx\nserver/mcp/protocol.ts\n')
  assert.equal(got.code, 1)
  assert.equal(got.out, 'scope=hold hits=2\nserver/auth.ts — 認証・同一オリジン・tailnet\nserver/mcp/protocol.ts — セッション同士のメッセージ・/mcp・預かり・待ち・ループ\n')
})

test('分からないときは止まる側に倒す（一覧が空・引けない・使い方が違う）', async () => {
  assert.deepEqual(await run(['-'], ''), { code: 1, out: 'scope=hold reason=unreadable\n' })
  assert.deepEqual(await run(['-'], '\n  \n'), { code: 1, out: 'scope=hold reason=unreadable\n' })
  assert.deepEqual(await run([]), { code: 1, out: 'scope=hold reason=usage\n' })
  assert.deepEqual(await run(['12; echo x']), { code: 1, out: 'scope=hold reason=usage\n' })
  assert.deepEqual(await run(['999999']), { code: 1, out: 'scope=hold reason=unreadable\n' }, 'gh が無い・失敗した')
})
