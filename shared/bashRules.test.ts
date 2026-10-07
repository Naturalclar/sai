import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bashRulePlan, bashRulePrefixes } from './bashRules.ts'

const CWD = '/w/repo'
const p = (command: string, cwd = CWD) => bashRulePrefixes(command, cwd)

test('bashRulePrefixes: 1 つのコマンドは先頭 1 語（サブコマンドを持つ CLI は 2 語）', () => {
  assert.deepEqual(p('gh pr create --title x'), ['gh pr'])
  assert.deepEqual(p('git push origin main'), ['git push'])
  assert.deepEqual(p('mkdir -p x/y'), ['mkdir'])
  assert.deepEqual(p('gh --version'), ['gh'], '2 語目がフラグなら 1 語')
  assert.deepEqual(p('./scripts/run.sh'), ['./scripts/run.sh'])
  assert.equal(p(''), null)
  assert.equal(p('"quoted cmd"'), null, '空白の入った先頭は当てにしない')
})

test('bashRulePrefixes: つないだコマンドは部品ごと（&& / || / ; / 改行 / パイプ）。同じ接頭辞は 1 つ（#705）', () => {
  assert.deepEqual(p('touch x && mkdir d'), ['touch', 'mkdir'])
  assert.deepEqual(p('touch a; mkdir b'), ['touch', 'mkdir'])
  assert.deepEqual(p('touch a && mkdir b || rm -f c'), ['touch', 'mkdir', 'rm'])
  assert.deepEqual(p('touch a\nmkdir b'), ['touch', 'mkdir'])
  assert.deepEqual(p('touch a || touch b'), ['touch'])
  assert.deepEqual(p('node -v | tee v.txt'), ['node', 'tee'], 'パイプの後ろも部品（tee のルールが無いと聞かれた）')
  assert.deepEqual(p('gh pr list && rm -rf x'), ['gh pr', 'rm'], '前は && の手前だけ見て gh pr のルールしか書かなかった')
  assert.deepEqual(p('touch "a && b"'), ['touch'], '引用符の中の && では切らない')
  assert.deepEqual(p("touch 'a | b'; mkdir c"), ['touch', 'mkdir'])
})

test('bashRulePrefixes: 読むだけのコマンドと cd にはルールを書かない（ルール無しで通った）', () => {
  assert.deepEqual(p('pnpm test 2>&1 | tail -20'), ['pnpm test'])
  assert.deepEqual(p('node -v | grep v | sort | uniq | wc -l'), ['node'])
  assert.deepEqual(p('node -v && echo done; pwd; ls'), ['node'])
  assert.deepEqual(p('node -v | awk "{print}"'), ['node', 'awk'], 'awk は聞かれた（引用符の中の波括弧は文字）')
  assert.deepEqual(p('ls -la | head'), ['ls', 'head'], '読むだけのコマンドしか無いのに聞かれたなら、その部品に書く（#710 のレビュー）')
  assert.deepEqual(p('cat /etc/hosts'), ['cat'], '引数しだいで聞かれる。前は出ていた [常に許可] を消さない')
  assert.deepEqual(p('cd sub && cat ../../x | head'), ['cat', 'head'])
  assert.deepEqual(p('cd sub && grep -r x . | wc -l'), ['grep', 'wc'])
  assert.deepEqual(p('cd sub'), [], 'cd だけなら書くルールが無い（Bash(cd:*) は一度も効かない）')
  assert.deepEqual(p('cd sub && pnpm test'), ['pnpm test'])
  assert.deepEqual(p('cd /w/repo/sub && pnpm -v | tail -5'), ['pnpm'])
  assert.deepEqual(p('cd sub && cd .. && node -v'), ['node'])
  assert.deepEqual(p('cd sub && chmod +x f && ln -s a b'), ['chmod', 'ln'], 'chmod / ln は cd のあとでも通った')
})

test('bashRulePrefixes: cd の行き先がプロジェクトの外・分からないときは出さない（Bash(cd:*) があっても聞かれた）', () => {
  assert.equal(p('cd /tmp && node -v'), null)
  assert.equal(p('cd ../.. && node -v'), null)
  assert.equal(p('cd sub/../../x && node -v'), null)
  assert.equal(p('cd /w/repo-other && node -v'), null, '名前の前方一致で中と見なさない')
  assert.equal(p('cd ~/x && node -v'), null)
  assert.equal(p('cd - && node -v'), null)
  assert.equal(p('cd && node -v'), null)
  assert.equal(p('cd sub && node -v', ''), null, 'cwd が分からなければ確かめられない')
  assert.deepEqual(p('node -v', ''), ['node'], 'cd が無ければ cwd は要らない')
})

test('bashRulePrefixes: cd と書き込み系・git をつないだものは出さない（ルールが揃っていても聞かれた）', () => {
  for (const cmd of ['touch x', 'mkdir d', 'rm -f x', 'cp a b', 'mv a b', 'sed -i "" s/a/b/ f', 'tee f', 'git status']) {
    assert.equal(p(`cd sub && ${cmd}`), null, cmd)
  }
  assert.equal(p('cd sub; touch x'), null)
  assert.equal(p('touch sub/x && cd sub'), null, '順が逆でも')
  assert.equal(p('mkdir d && cd d && touch x'), null)
  assert.equal(p('cd sub && pnpm -v && git status'), null)
  assert.deepEqual(p('touch sub/x && git status'), ['touch', 'git status'], 'cd が無ければ出す')
})

test('bashRulePrefixes: 環境変数の代入は接頭辞に入れる（Bash(touch:*) では通らず Bash(FOO=1 touch:*) で通った）', () => {
  assert.deepEqual(p('FOO=1 touch x'), ['FOO=1 touch'])
  assert.deepEqual(p('FOO=1 BAR=2 touch x'), ['FOO=1 BAR=2 touch'])
  assert.deepEqual(p('ASDF_NODEJS_VERSION=22.23.1 pnpm test && pnpm lint'), ['ASDF_NODEJS_VERSION=22.23.1 pnpm test', 'pnpm lint'])
  assert.deepEqual(p('cd sub && FOO=1 pnpm -v'), ['FOO=1 pnpm'])
  assert.deepEqual(p('FOO=1 grep x f'), ['FOO=1 grep'], '代入が付くと読むだけのコマンドでも聞かれうるので書く')
  assert.equal(p('FOO="a b" touch x'), null, '値に空白があると表記が揃わない')
  assert.equal(p('FOO=1'), null, '代入だけ')
})

test('bashRulePrefixes: 展開・構文・ファイルへのリダイレクト・バックグラウンドは出さない（ルールがあっても聞かれた）', () => {
  for (const cmd of [
    '$(echo x)',
    'touch $(echo x)',
    'touch "$(echo x)"',
    'touch `echo x`',
    'touch "$PWD/x"',
    'touch x$FOO',
    'touch a{1,2}',
    'for i in 1 2; do touch $i; done',
    'for i in 1 2; do touch x; done',
    'while true; do node -v; done',
    'if node -v; then touch x; fi',
    '(touch a && mkdir b)',
    'touch a && { mkdir b; }',
    '! node -v',
    'echo hi > y.txt',
    'node -v > out.txt',
    'node -v >> out.txt',
    'node -v 2> err.txt',
    'node -v &> all.txt',
    'node -v < in.txt',
    'node -v & touch x',
    'node -v |& tee x',
    'touch x # 行の途中のコメント',
    "touch 'x",
    'touch "x',
    'cat <<EOF\nx\nEOF',
  ]) assert.equal(p(cmd), null, cmd)
})

test('bashRulePrefixes: fd の付け替え・/dev/null・行ごとのコメント・コミットメッセージのヒアドキュメントは通った', () => {
  assert.deepEqual(p('node -v 2>&1'), ['node'])
  assert.deepEqual(p('node -v 2>/dev/null'), ['node'])
  assert.deepEqual(p('node -v >/dev/null 2>&1'), ['node'])
  assert.deepEqual(p('node -v > /dev/null'), ['node'])
  assert.deepEqual(p('node -v &>/dev/null'), ['node'])
  assert.deepEqual(p('touch x < /dev/null'), ['touch'])
  assert.equal(p('node -v > /dev/nullx'), null)
  assert.deepEqual(p('touch a 2>&1 | tee -a log; mkdir b'), ['touch', 'tee', 'mkdir'])
  assert.deepEqual(p('# make it\ntouch x'), ['touch'])
  assert.deepEqual(p('touch a\n  # then\nmkdir b'), ['touch', 'mkdir'])
  assert.deepEqual(p('git commit -m "$(cat <<\'EOF\'\nmsg && more $x\n\n(body)\nEOF\n)"'), ['git commit'])
  assert.deepEqual(p('git add -A && git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)" && git push'), ['git add', 'git commit', 'git push'])
  assert.deepEqual(p('touch a \\\n  b && mkdir c'), ['touch', 'mkdir'], '行の継続')
  assert.deepEqual(p('# note \\\nrm -rf build\npnpm test'), ['rm', 'pnpm test'], 'コメントの中の \\ は継続にしない（次の行を捨てない。#710 のレビュー）')
  assert.deepEqual(p('pnpm \\\ntest'), ['pnpm test'])
  assert.deepEqual(p('touch file2.txt'), ['touch'], '数字で終わる語はリダイレクトと読み違えない')
})

test('bashRulePlan: 組めなかった理由の種類を返す（#724）。判定は bashRulePrefixes と同じ 1 つ', () => {
  const reason = (command: string, cwd = CWD) => {
    const plan = bashRulePlan(command, cwd)
    return 'reason' in plan ? plan.reason : plan.prefixes
  }
  const cases: [string, string][] = [
    ['echo $(date)', 'expansion'],
    ['echo "$HOME"', 'expansion'],
    ['echo `date`', 'expansion'],
    ['pnpm test > out.txt', 'redirect'],
    ['pnpm test 2> err.txt', 'redirect'],
    ['pnpm test &> all.txt', 'redirect'],
    ['pnpm test |& tee log', 'redirect'],
    ['cat <<EOF\nx\nEOF', 'heredoc'],
    ['zzrun 2<<EOF\nx\nEOF', 'heredoc'],
    ['grep x <<< abc', 'here_string'],
    ['diff <(zzrun a) <(zzrun b)', 'subshell'],
    ['zzrun >(tee log)', 'subshell'],
    ['zzrun > >(tee log)', 'redirect'],
    ['pnpm start &', 'background'],
    ['(cd sub && pnpm test)', 'subshell'],
    ['{ pnpm test; }', 'brace'],
    ['pnpm test # あとで', 'comment'],
    ["echo 'abc", 'unclosed'],
    ['echo "abc', 'unclosed'],
    ['pnpm test \\', 'unclosed'],
    ['for i in 1 2; do pnpm test; done', 'keyword'],
    ['if true; then pnpm test; fi', 'keyword'],
    ['[ -f x ] && pnpm test', 'odd_command'],
    ['FOO=1', 'assign_only'],
    ['A=1 B=2', 'assign_only'],
    ['! zzrun', 'odd_command'],
    ['git show HEAD@{1}', 'brace'],
    ['echo $(x) > out.txt', 'expansion'],
    ['FOO="a b" touch x', 'env_value'],
    ['cd', 'cd_form'],
    ['cd -', 'cd_form'],
    ['cd ~/x && pnpm test', 'cd_form'],
    ['cd a b', 'cd_form'],
    ['cd /tmp && pnpm test', 'cd_outside'],
    ['cd .. && pnpm test', 'cd_outside'],
    ['cd sub && git status', 'cd_then_write'],
    ['touch sub/x && cd sub', 'cd_then_write'],
    ['', 'empty'],
    ['# コメントだけ', 'empty'],
  ]
  for (const [command, want] of cases) {
    assert.equal(reason(command), want, command)
    assert.equal(p(command), null, `${command}: 理由があるなら [常に許可] は出さない`)
  }
  assert.equal(reason('cd sub && pnpm test', ''), 'cd_no_cwd')
  // 組めたときは理由を持たない。cd しか無いときは空の配列（理由 cd_only は呼ぶ側が付ける）
  assert.deepEqual(bashRulePlan('cd sub && pnpm test | tail -5', CWD), { prefixes: ['pnpm test'] })
  assert.deepEqual(bashRulePlan('cd sub', CWD), { prefixes: [] })
  // 理由は種類だけ。コマンドの文字を混ぜない
  assert.deepEqual(bashRulePlan('echo $(cat /secret/path)', CWD), { reason: 'expansion' })
})
