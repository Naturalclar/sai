import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COMPOSED_MAX_CHARS, composedVerdict } from './bashComposed.ts'
import type { ComposedPlace } from './bashComposed.ts'

// コマンド・パス・ルールは全部作り物。**このテストはコマンドを 1 つも実行しない**（文字列を判定の関数に渡すだけ）
const CWD = '/work/repo/pkg'
const place = (over: Partial<ComposedPlace> = {}): ComposedPlace => ({
  cwd: CWD,
  roots: ['/work/repo', '/work/repo-b'],
  repo: 'o/r',
  home: '/home/me',
  allow: ['Bash(tool-a build:*)', 'Bash(tool-b *)', 'Bash(tool-c)'],
  block: [],
  ...over,
})
const verdict = (command: string, over: Partial<ComposedPlace> = {}) => composedVerdict(command, place(over))
const ok = (command: string, over: Partial<ComposedPlace> = {}) => {
  const v = verdict(command, over)
  assert.equal(v.ok, true, `${command} → ${JSON.stringify(v)}`)
  return v
}
const no = (command: string, over: Partial<ComposedPlace> = {}) => {
  const v = verdict(command, over)
  assert.equal(v.ok, false, `${command} は人に回るはず`)
  return v
}

test('composedVerdict: 部品が全部ルールに当たり、受けるつなぎ方だけなら通す（#863）', () => {
  assert.deepEqual(ok('tool-a build x && tool-b y'), { ok: true, rule: 2, read: 0 })
  ok('tool-a build x || tool-b y')
  ok('tool-a build x; tool-b y')
  ok('tool-a build x\ntool-b y')
  ok('tool-a build | tool-b y')
  ok('tool-c && tool-a build')
  // 捨てるだけのリダイレクト
  ok('tool-a build x 2>&1 && tool-b y >/dev/null')
  ok('tool-a build x 2>/dev/null; tool-b')
})

test('composedVerdict: 1 つでも当たらない部品があれば人に回す（#863）', () => {
  assert.deepEqual(no('tool-a build x && tool-z y'), { ok: false, part: 'command' })
  // 完全一致のルールは、引数が足されると当たらない
  no('tool-c extra && tool-a build')
  // 前方一致は語の単位（`tool-a buildx` は `tool-a build` に当たらない）
  no('tool-a buildx && tool-b y')
  // 当てる形が分からない書き方のルールは当てない
  no('tool-q run x && tool-a build', { allow: ['Bash(tool-q * x)', 'Bash(tool-a build:*)'] })
  // 前に付ける語・引数を走らせる語は、ルールがあっても当てない
  no('xargs tool-z && tool-a build', { allow: ['Bash(xargs:*)', 'Bash(tool-a build:*)'] })
})

test('composedVerdict: 読むだけの部品とルールの部品を組み合わせて通す。パイプの後ろも同じ関数で見る（#863）', () => {
  assert.deepEqual(ok('tool-a build x && git status'), { ok: true, rule: 1, read: 1 })
  // `head -5` は単独だと読むだけと言えない（端末を読む）が、パイプの後ろなら読むだけ
  assert.deepEqual(ok('tool-a build x | head -5'), { ok: true, rule: 1, read: 1 })
  no('tool-a build x && head -5')
  ok('git log --oneline -3 | grep fix | tail -2')
})

test('composedVerdict: 中身が文字だけの echo は通し、変数は人に回す（#863）', () => {
  ok('echo "=== a ===" && tool-a build x')
  ok("echo 'done' && tool-b y")
  assert.deepEqual(no('echo $X && tool-a build'), { ok: false, form: 'expansion' })
  assert.deepEqual(no('echo "${X}" && tool-a build'), { ok: false, form: 'expansion' })
})

test('composedVerdict: ファイルに書く・ヒアドキュメント・代入・サブシェル・知らない構文は人に回す（#863）', () => {
  assert.deepEqual(no('tool-a build x > out.txt'), { ok: false, form: 'redirect' })
  assert.deepEqual(no('tool-a build x >> out.txt && tool-b'), { ok: false, form: 'redirect' })
  assert.deepEqual(no("tool-b <<'EOF'\nbody\nEOF"), { ok: false, form: 'heredoc' })
  assert.deepEqual(no('tool-b "$(cat <<\'EOF\'\nbody\nEOF\n)"'), { ok: false, form: 'heredoc' })
  assert.deepEqual(no('X=1 tool-a build'), { ok: false, form: 'assign' })
  assert.deepEqual(no('X=1 && tool-a build'), { ok: false, form: 'assign' })
  assert.deepEqual(no('(tool-a build x)'), { ok: false, form: 'subshell' })
  assert.deepEqual(no('tool-a build x &'), { ok: false, form: 'background' })
  assert.deepEqual(no('if tool-c; then tool-b; fi'), { ok: false, form: 'keyword' })
  assert.deepEqual(no('tool-a build `tool-z`'), { ok: false, form: 'expansion' })
  assert.deepEqual(no('tool-a build $((1+2))'), { ok: false, form: 'expansion' })
  assert.deepEqual(no('{ tool-a build; }'), { ok: false, form: 'brace' })
  assert.deepEqual(no('tool-a build # note'), { ok: false, form: 'comment' })
  assert.deepEqual(no('# note\ntool-a build'), { ok: false, form: 'comment' })
  no('tool-a build x <(tool-b)')
  no(`tool-a build ${'x'.repeat(COMPOSED_MAX_CHARS)}`)
})

test('composedVerdict: $( … ) は中身の部品も許されているときだけ通す（#863）', () => {
  assert.deepEqual(ok('tool-b "$(tool-a build x)"'), { ok: true, rule: 2, read: 0 })
  ok('tool-b $(git rev-parse HEAD)')
  ok('echo "at $(git rev-parse --short HEAD)"')
  // 中身が許されていない
  assert.deepEqual(no('tool-b "$(tool-z x)"'), { ok: false, part: 'command' })
  // 中身の分からない語は、ルールの語に使えない
  no('tool-a $(tool-c) x')
  // 中に `cd` を入れても外には効かないので、受けない
  no('tool-b "$(cd /work/repo && tool-c)"')
  // 閉じていない
  no('tool-b "$(tool-c"')
})

test('composedVerdict: 文字の並びを回す for だけ通す（#863）', () => {
  assert.deepEqual(ok('for f in a.ts b.ts; do tool-b $f; done'), { ok: true, rule: 2, read: 0 })
  ok('for f in a b\ndo\n  tool-b "$f"\ndone')
  ok('for f in a b; do tool-b ${f} && tool-c; done | tail -3')
  // 並びが文字でない
  assert.deepEqual(no('for f in $(tool-c); do tool-b $f; done'), { ok: false, form: 'for_form' })
  assert.deepEqual(no('for f in *.ts; do tool-b $f; done'), { ok: false, form: 'for_form' })
  assert.deepEqual(no('for f in "a b"; do tool-b $f; done'), { ok: false, form: 'for_form' })
  // 中身にほかの変数・許されていない部品・cd
  assert.deepEqual(no('for f in a; do tool-b $g; done'), { ok: false, form: 'expansion' })
  no('for f in a; do tool-z $f; done')
  no('for f in a; do cd $f && tool-c; done')
  // 一重引用符の中の `$f` は置き換えない（シェルも展開しない）ので、字のまま残る
  ok("for f in a; do tool-b '$f'; done")
  // 閉じていない・形が違う
  no('for f in a; do tool-b $f')
  no('for f; do tool-b $f; done')
})

test('composedVerdict: そのセッションのリポジトリの中への cd だけ通し、場所を変えて次の部品を見る（#863）', () => {
  ok('cd /work/repo && tool-a build')
  // 同じリポジトリの別の worktree（#783）
  ok('cd /work/repo-b/src && git status')
  ok('cd .. && tool-c')
  // 外
  assert.deepEqual(no('cd /work/other && tool-a build'), { ok: false, form: 'cd_outside' })
  assert.deepEqual(no('cd ../.. && tool-a build'), { ok: false, form: 'cd_outside' })
  no('cd ~ && tool-c')
  // cd のあとは `&&` だけ（失敗したら元の場所で次が走る）
  assert.deepEqual(no('cd /work/repo; tool-c'), { ok: false, form: 'cd_join' })
  no('cd /work/repo || tool-c')
  no('tool-c | cd /work/repo')
  // 読めない行き先
  no('cd $D && tool-c')
  no('cd /work/re* && tool-c')
  no('cd -P /work/repo && tool-c')
  // cwd もリポジトリも分からない
  no('cd /work/repo && tool-c', { roots: [] })
  // cd だけなら答えない
  no('cd /work/repo')
  // 行に書かれた cwd の書き方で来た行き先は、realpath に読み替える
  ok('cd /link/repo/pkg && tool-c', { cwd: '/work/repo', written: '/link/repo' })
  no('cd /link/other && tool-c', { cwd: '/work/repo', written: '/link/repo' })
})

test('composedVerdict: ask / deny のルールに当たりうる部品があれば答えない（#863）', () => {
  assert.deepEqual(no('tool-a build x && tool-b y', { block: ['Bash(tool-b:*)'] }), { ok: false, part: 'blocked' })
  no('git status && tool-c', { block: ['Bash(git status)'] })
  // 当てる形が分からない書き方は全部に当たる扱い
  no('tool-a build x && tool-c', { block: ['Bash(tool-* x)'] })
  no('tool-a build x', { block: ['Bash'] })
  // Bash 以外のルールは関係ない
  ok('tool-a build x && tool-c', { block: ['Read(./secret/**)'] })
})

test('composedVerdict: ルールが無く読むだけでもない・空は答えない（#863）', () => {
  no('tool-a build x', { allow: [] })
  no('')
  no('   ')
})
