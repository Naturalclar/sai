import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alwaysAllowRules, ruleLabel } from './approvals.ts'
import { bashRulePlan, bashRulePrefixes } from './bashRules.ts'

const CWD = '/w/repo'
// ホームは渡さない（`~` は読めない形のまま。渡したときの読み方は下の #724 の節）
const p = (command: string, cwd = CWD) => bashRulePrefixes(command, cwd, '')

test('bashRulePrefixes: 1 つのコマンドは先頭 1 語（サブコマンドを持つ CLI は 2 語）', () => {
  assert.deepEqual(p('gh pr create --title x'), ['gh pr'])
  assert.deepEqual(p('git push origin main'), ['git push'])
  assert.deepEqual(p('mkdir -p x/y'), ['mkdir'])
  assert.deepEqual(p('gh --version'), ['gh --version'], '2 語目がフラグなら 1 語にせず、フラグごと（#755）')
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
  assert.deepEqual(p('node -v | tee v.txt'), ['node -v', 'tee'], 'パイプの後ろも部品（tee のルールが無いと聞かれた）')
  assert.deepEqual(p('gh pr list && rm -rf x'), ['gh pr', 'rm'], '前は && の手前だけ見て gh pr のルールしか書かなかった')
  assert.deepEqual(p('touch "a && b"'), ['touch'], '引用符の中の && では切らない')
  assert.deepEqual(p("touch 'a | b'; mkdir c"), ['touch', 'mkdir'])
})

test('bashRulePrefixes: 読むだけのコマンドと cd にはルールを書かない（ルール無しで通った）', () => {
  assert.deepEqual(p('pnpm test 2>&1 | tail -20'), ['pnpm test'])
  assert.deepEqual(p('node -v | grep v | sort | uniq | wc -l'), ['node -v'])
  assert.deepEqual(p('node -v && echo done; pwd; ls'), ['node -v'])
  assert.deepEqual(p('node -v | awk "{print}"'), ['node -v', 'awk'], 'awk は聞かれた（引用符の中の波括弧は文字）')
  assert.deepEqual(p('ls -la | head'), ['ls', 'head'], '読むだけのコマンドしか無いのに聞かれたなら、その部品に書く（#710 のレビュー）')
  assert.deepEqual(p('cat /etc/hosts'), ['cat'], '引数しだいで聞かれる。前は出ていた [常に許可] を消さない')
  assert.deepEqual(p('cd sub && cat ../../x | head'), ['cat', 'head'])
  assert.deepEqual(p('cd sub && grep -r x . | wc -l'), ['grep', 'wc'])
  assert.deepEqual(p('cd sub'), [], 'cd だけなら書くルールが無い（Bash(cd:*) は一度も効かない）')
  assert.deepEqual(p('cd sub && pnpm test'), ['pnpm test'])
  assert.deepEqual(p('cd /w/repo/sub && pnpm -v | tail -5'), ['pnpm -v'])
  assert.deepEqual(p('cd sub && cd .. && node -v'), ['node -v'])
  assert.deepEqual(p('cd sub && chmod +x f && ln -s a b'), ['chmod', 'ln'], 'chmod / ln は cd のあとでも通った')
})

test('bashRulePrefixes: cd の行き先がプロジェクトの外・分からないときは出さない（Bash(cd:*) があっても聞かれた）', () => {
  assert.equal(p('cd /tmp && node -v'), null)
  assert.equal(p('cd ../.. && node -v'), null)
  assert.equal(p('cd sub/../../x && node -v'), null)
  assert.equal(p('cd /w/repo-other && node -v'), null, '名前の前方一致で中と見なさない')
  assert.equal(p('cd ~/x && node -v'), null, 'ホームを渡さなければ ~ は読めない')
  assert.equal(p('cd - && node -v'), null)
  assert.equal(p('cd && node -v'), null)
  assert.equal(p('cd sub && node -v', ''), null, 'cwd が分からなければ確かめられない')
  assert.deepEqual(p('node -v', ''), ['node -v'], 'cd が無ければ cwd は要らない')
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
  assert.deepEqual(p('cd sub && FOO=1 pnpm -v'), ['FOO=1 pnpm -v'])
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
  assert.deepEqual(p('node -v 2>&1'), ['node -v'])
  assert.deepEqual(p('node -v 2>/dev/null'), ['node -v'])
  assert.deepEqual(p('node -v >/dev/null 2>&1'), ['node -v'])
  assert.deepEqual(p('node -v > /dev/null'), ['node -v'])
  assert.deepEqual(p('node -v &>/dev/null'), ['node -v'])
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
    const plan = bashRulePlan(command, cwd, '')
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
  assert.deepEqual(bashRulePlan('cd sub && pnpm test | tail -5', CWD, ''), { prefixes: ['pnpm test'] })
  assert.deepEqual(bashRulePlan('cd sub', CWD, ''), { prefixes: [] })
  // 理由は種類だけ。コマンドの文字を混ぜない
  assert.deepEqual(bashRulePlan('echo $(cat /secret/path)', CWD, ''), { reason: 'expansion' })
})

// ---- #724 の次の段: 記録で多かった理由のうち、実機（Claude Code 2.1.292）で通った形だけ組む
const HOME = '/home/someone'
const IN_HOME = '/home/someone/work/repo'
const h = (command: string, cwd = IN_HOME, home = HOME) => bashRulePlan(command, cwd, home)

test('cd ~/…: ホームに読み替えて、プロジェクトの中へ行くものは中への cd と同じに読む', () => {
  assert.deepEqual(h('cd ~/work/repo && gh issue view 1'), { prefixes: ['gh issue'] })
  assert.deepEqual(h('cd ~/work/repo/sub\nnode -v'), { prefixes: ['node -v'] })
  assert.deepEqual(h('cd ~/work/repo/sub/..; node -v | tail -1'), { prefixes: ['node -v'] })
  assert.deepEqual(h('cd ~/work/repo'), { prefixes: [] }, 'cd だけなら書くルールは無い')
  // ホームの末尾の / は無視する
  assert.deepEqual(h('cd ~/work/repo && node -v', IN_HOME, '/home/someone/'), { prefixes: ['node -v'] })
})

test('cd ~/…: 外へ行くものは cd_outside（外への cd はルールがあっても聞かれた）。書き込み系・git とのつなぎも今までどおり', () => {
  assert.deepEqual(h('cd ~ && node -v'), { reason: 'cd_outside' })
  assert.deepEqual(h('cd ~/work && node -v'), { reason: 'cd_outside' })
  assert.deepEqual(h('cd ~/work/repo-other && node -v'), { reason: 'cd_outside' })
  assert.deepEqual(h('cd ~/work/repo/../../.. && node -v'), { reason: 'cd_outside' })
  assert.deepEqual(h('cd ~/work/repo && git status'), { reason: 'cd_then_write' })
  assert.deepEqual(h('cd ~/work/repo && touch x'), { reason: 'cd_then_write' })
})

test('cd ~/…: ホームが分からない・~user・引用符つきの ~ は読めない形のまま', () => {
  // 引用符・バックスラッシュの付いた ~ は、bash が展開しない（./~/… という相対パス）。読み替えない（#751 のレビュー）
  for (const cd of ["cd '~/work/repo/sub'", 'cd "~/work/repo/sub"', 'cd \\~/work/repo/sub', "cd ~'/work/repo/sub'", 'cd ~/work/"repo"/sub']) {
    assert.deepEqual(h(`${cd} && node -v`), { reason: 'cd_form' }, cd)
  }
  // 読み替えるのは最初の部品だけ。前に何かあると、そこで HOME が変わっていても見抜けない（#751 のレビュー）
  for (const before of ['export HOME=/tmp/x', 'unset HOME', 'export HOME+=/else', 'X=1 eval x', 'source ./env.sh', 'node -v', 'cd sub']) {
    assert.deepEqual(h(`${before} && cd ~/work/repo && node -v`), { reason: 'cd_form' }, before)
  }
  assert.deepEqual(h('cd ~/work/repo && export HOME=/tmp/x && node -v'), { prefixes: ['export', 'node -v'] }, 'cd のあとで触るのは行き先に効かない')
  // 行の継続のすぐあとの ~ は、引用符つきではない
  assert.deepEqual(h('cd \\\n~/work/repo && node -v'), { prefixes: ['node -v'] })
  assert.deepEqual(bashRulePlan('cd ~/work/repo && node -v', IN_HOME, ''), { reason: 'cd_form' }, 'ホームが空')
  assert.deepEqual(h('cd ~other/work && node -v'), { reason: 'cd_form' })
  assert.deepEqual(h('cd ~+ && node -v'), { reason: 'cd_form' })
  assert.deepEqual(h('cd ~/work/repo extra && node -v'), { reason: 'cd_form' })
  assert.deepEqual(h('cd ~/work/repo && node -v', ''), { reason: 'cd_no_cwd' })
})

const doc = (head: string, body = 'title\n\n$(touch x) && rm y > z; (a) {b} `c` | d', tag = "'EOF'", close = 'EOF') => `${head} <<${tag}\n${body}\n${close}`

test('引用符つきの目印のヒアドキュメント: 本文を文章として受け取るコマンド（gh / git）は、本文を読み飛ばして組む', () => {
  assert.deepEqual(h(doc('gh issue comment 1 --body-file -')), { prefixes: ['gh issue'] })
  assert.deepEqual(h(doc('git commit -q -F -')), { prefixes: ['git commit'] })
  assert.deepEqual(h(doc('gh pr create --body-file -', 'x', '"EOF"')), { prefixes: ['gh pr'] }, '二重引用符の目印')
  assert.deepEqual(h('gh pr comment 1 --body-file - <<-\'EOF\'\n\tbody\n\tEOF'), { prefixes: ['gh pr'] }, '<<- は閉じの行の頭のタブを許す')
  // 前後に別のコマンドがあるもの（前は ; や改行、後ろは閉じの行の次の行）
  assert.deepEqual(h(`cd sub; ${doc('gh pr comment 1 -F -')}\ngh pr view 1`), { prefixes: ['gh pr'] })
  // 2 つ目のヒアドキュメントは、前に cd 以外の部品があるので組まない（4 回目のレビュー）
  assert.deepEqual(h(`${doc('gh issue comment 1 --body-file -')}\n${doc('gh issue comment 2 --body-file -', 'y', "'MD'", 'MD')}`), { reason: 'heredoc' })
  // 本文に閉じの目印と同じ語が文の途中にあっても、行がその語だけのときにしか閉じない
  assert.deepEqual(h(doc('gh issue comment 1 --body-file -', 'see EOF here\n EOF\nEOFX')), { prefixes: ['gh issue'] })
})

test('ヒアドキュメント: python3 に渡す形は組む（人が決めた。書かれるのは Bash(python3:*) = python3 で始まるコマンドは何でも通る広さ）', () => {
  for (const head of ['python3 -', 'python3', 'python3 - a b', 'python3 -u -']) {
    assert.deepEqual(h(doc(head, 'print(1)')), { prefixes: ['python3'] }, head)
  }
  // 中への cd のあと・閉じの行のあとの別のコマンド
  assert.deepEqual(h(`cd ~/work/repo/sub\n${doc('python3 -', 'print(1)')}`), { prefixes: ['python3'] })
  assert.deepEqual(h(`cd sub; ${doc('python3 -', 'print(1)')}\nnode -v | tail -1`), { prefixes: ['python3', 'node -v'] })
  // ルールの表記は広さをそのまま言う（狭い形に見せない）
  assert.deepEqual(alwaysAllowRules('Bash', { command: doc('python3 -', 'print(1)') }, IN_HOME, HOME).map(ruleLabel), ['Bash(python3:*)'])
})

test('1 語のルール Bash(python3:*) を書く例外は、ヒアドキュメントで渡したプログラムを走らせる python3 だけ（#755 の「1 語のルールは書かない」の例外）', () => {
  // ヒアドキュメントが無ければ、#755 のとおり組まない
  for (const command of ['python3 -', "python3 -c 'print(1)'", 'python3 - x', 'python3 -u -', 'python3']) {
    const plan = h(command)
    if (command === 'python3') assert.deepEqual(plan, { prefixes: ['python3'] }, '引数の無い python3 は前から 1 語')
    else assert.deepEqual(plan, { reason: 'bare_cli' }, command)
  }
  // ヒアドキュメントがあっても、本文がプログラムでない形（-c・-m・スクリプトのファイル・値を取るフラグ）には当てない
  assert.deepEqual(h(doc("python3 -c 'print(1)'", 'data')), { reason: 'heredoc' })
  for (const head of ['python3 -W ignore -', 'python3 -W ignore', 'python3 -X dev -', 'python3 -X dev', 'python3 -c pass', 'python3 -uc pass', 'python3 -m json.tool', 'python3 tool.py --in -', 'python3 tool.py']) {
    assert.deepEqual(h(doc(head, 'print(1)')), { reason: 'heredoc' }, `${head}（確かめていない形は、ヒアドキュメントごと断る）`)
  }
  // 目印の前のリダイレクトも確かめていないので断る（gh / git の形も同じ）
  assert.deepEqual(h("python3 - 2>&1 <<'EOF'\nprint(1)\nEOF"), { reason: 'heredoc' })
  assert.deepEqual(h("python3 2>/dev/null - <<'EOF'\nprint(1)\nEOF"), { reason: 'heredoc' })
  assert.deepEqual(h("gh pr comment 1 -F - 2>&1 <<'EOF'\nb\nEOF"), { reason: 'heredoc' })
  // 1 語の python3 に覆われる狭いルールは並べない
  assert.deepEqual(h(`${doc('python3 -', 'print(1)')}\npython3 tool.py\nnode -v`), { prefixes: ['python3', 'node -v'] })
  // 当てる形: 標準入力からプログラムを読む
  for (const head of ['python3', 'python3 -', 'python3 -u -', 'python3 -Es', 'python3 - a b', 'python3 -B - --flag']) {
    assert.deepEqual(h(doc(head, 'print(1)')), { prefixes: ['python3'] }, head)
  }
  // 別の部品のヒアドキュメントでは当てない（ヒアドキュメントを受けたのは gh で、python3 -c は別の部品）
  assert.deepEqual(h(`${doc('cd sub; gh pr comment 1 -F -')}\npython3 -c 'print(1)'`), { reason: 'bare_cli' })
  // python3 以外には漏れない（ヒアドキュメントの入口で断る）
  for (const head of ['python -', 'python3.12 -', 'python3.13', '/usr/bin/python3 -', './python3 -', 'env python3 -', 'command python3 -', 'uv run python3 -', 'pipx run python3 -', 'node -', 'node', 'deno run -', 'bun -', 'ruby', 'perl', 'bash', 'sh', 'zsh', 'PYTHONPATH=x python3 -', 'python3x', 'Python3 -']) {
    assert.deepEqual(h(doc(head, 'print(1)')), { reason: 'heredoc' }, head)
  }
})

test('ヒアドキュメント: python3 でも、#751 で塞いだ形は同じに断る', () => {
  const py = doc('python3 -', 'print(1)')
  // 前にあるのが cd だけでない（コマンドを差し替えていても見抜けない）
  for (const before of ["eval 'python3() { sh; }'", 'alias python3=sh', 'export PATH=/tmp/x:/usr/bin', 'source ./x.sh', 'node -v', 'git add -A']) {
    assert.deepEqual(h(`${before}\n${py}`), { reason: 'heredoc' }, before)
  }
  // 本文の外のコマンドを見落とさない（閉じの行のあとは、ふつうの部品として読む）
  assert.deepEqual(h(`${py}\nrm -rf x`), { prefixes: ['python3', 'rm'] })
  assert.deepEqual(h(`${py}\nzzrun x > out.txt`), { reason: 'redirect' })
  assert.deepEqual(h(`${py}\necho $HOME`), { reason: 'expansion' })
  assert.deepEqual(h(`${py}\n${py}`), { reason: 'heredoc' }, '2 つ目は前に cd 以外がある')
  // 実機で聞かれた形・読めない形
  assert.deepEqual(h('python3 - <<EOF\nprint(1)\nEOF'), { reason: 'heredoc' }, '目印を囲まない')
  assert.deepEqual(h("python3 - <<'EOF' | tail -1\nprint(1)\nEOF"), { reason: 'heredoc' })
  assert.deepEqual(h("python3 - <<'EOF' > out.txt\nprint(1)\nEOF"), { reason: 'heredoc' })
  assert.deepEqual(h("python3 - 3<<'EOF'\nprint(1)\nEOF"), { reason: 'heredoc' })
  assert.deepEqual(h("python3 - <<'EOF'\nprint(1)\nEOF\r\n"), { reason: 'odd_command' })
  assert.deepEqual(h("python3 - <<'EOF'\nprint(1)"), { reason: 'heredoc' }, '閉じの行が無い')
  assert.deepEqual(h(`cd /tmp; ${py}`), { reason: 'cd_outside' })
  assert.deepEqual(h(`cd ~/elsewhere\n${py}`), { reason: 'cd_outside' })
  assert.deepEqual(h(doc('FOO=1 python3 -', 'print(1)')), { reason: 'heredoc' }, '代入つき')
  assert.deepEqual(h(doc('python3 -"$(cat <<\'X\'\nc\nX\n)"', 'print(1)')), { reason: 'heredoc' }, '畳んだ語が混ざる')
})

test('ヒアドキュメント: python3 以外のインタプリタ・シェルにはルールを書かない（決まっていない）', () => {
  // インタプリタ・シェルの一覧は上の「例外は…」のテストに置く。ここは、コードではないが本文を受け取るほかのコマンド
  for (const head of ['sh -s', 'psql', 'ssh host', 'tee out.txt', 'cat', 'FOO=1 gh-x']) {
    assert.deepEqual(h(doc(head, 'print(1)')), { reason: 'heredoc' }, head)
  }
  assert.deepEqual(h(`gh issue list; ${doc('node -', 'print(1)')}`), { reason: 'heredoc' }, '前のコマンドが良くても')
})

test('ヒアドキュメント: gh / git でも、本文を文章として受け取ると分かっている形だけ（先頭の語では決めない。#751 のレビュー）', () => {
  // 本文を操作・コード・鍵として受け取るサブコマンド
  for (const head of ['git apply', 'git am', 'git update-ref --stdin', 'git fast-import', 'git -c alias.x=!sh x', 'git -c core.editor=x commit -F -', 'git hash-object -w --stdin', 'gh auth login --with-token', 'gh api --input - repos/o/r/issues', 'gh api -F - x', 'gh extension exec foo', 'gh secret set X', 'gh issue comment 1', 'gh issue comment 1 --body-file body.md', 'gh pr checkout 1 -F -', 'gh issue list -F -', 'gh release upload v1 -F -', 'git commit -F msg.txt', 'git commit', 'git tag -F - v1', 'FOO=1 gh issue comment 1 --body-file -']) {
    assert.deepEqual(h(doc(head, 'x')), { reason: 'heredoc' }, head)
  }
  for (const [head, prefix] of [['gh issue create --title t --body-file -', 'gh issue'], ['gh pr comment 1 -F -', 'gh pr'], ['gh release create v1 --notes-file x --body-file=-', 'gh release'], ['git commit -q --allow-empty --file -', 'git commit'], ['git commit --file=-', 'git commit']] as const) {
    assert.deepEqual(h(doc(head, 'x')), { prefixes: [prefix] }, head)
  }
})

test('ヒアドキュメント: 本文の読み飛ばしで、本文の外のコマンドを見落とさない（#751 のレビュー）', () => {
  // 外側の本文の中に `"$(cat <<'B'` の字面があっても、外側は自分の閉じの行で終わり、そのあとの行はコマンドとして読む
  const nested = ["gh issue comment 1 --body-file - <<'A'", 'see "$(cat <<\'B\'', 'A', 'rm -rf x', 'zzfetch y > out', "gh issue comment 2 --body-file - <<'A'", 'B', ')"', 'A'].join('\n')
  assert.deepEqual(h(nested), { reason: 'redirect' })
  // リダイレクトの行を外すと、rm は部品として読まれ、そのあとの 2 つ目のヒアドキュメントで断る（どちらにしてもルールにはならない）
  assert.deepEqual(h(nested.replace('zzfetch y > out\n', '')), { reason: 'heredoc' })
  assert.deepEqual(h(nested.split('\n').slice(0, 4).join('\n')), { prefixes: ['gh issue', 'rm'] }, '外側の閉じの行のあとの rm が部品として見えている')
  // コメント行の中の同じ字面でも、次の行からを畳まない
  assert.deepEqual(h('# "$(cat <<\'B\'\nrm -rf x > y\nB\n)"\ngh pr view 1'), { reason: 'redirect' })
  // 引用符の外の `$(cat <<'B'` は今までどおり展開
  assert.deepEqual(h("git commit -m $(cat <<'B'\nmsg\nB\n)"), { reason: 'expansion' })
  // 閉じが無い `"$(cat <<'B'` は、ふつうの二重引用符として読んで展開で断る
  assert.deepEqual(h('git commit -m "$(cat <<\'B\'\nmsg\n)"'), { reason: 'expansion' })
})

test('記録に残る理由は、頭から読んで最初に当たった 1 つのまま（組まないヒアドキュメントは、あとの行の理由より先）', () => {
  assert.deepEqual(h(`${doc('node -', 'print(1)')}\necho $(date)`), { reason: 'heredoc' })
  assert.deepEqual(h(`${doc('node -', 'print(1)')}\nzzrun x > out`), { reason: 'heredoc' })
  assert.deepEqual(h(`echo $(date)\n${doc('node -', 'print(1)')}`), { reason: 'expansion' })
})

test('ヒアドキュメント: 実機で聞かれた形は今までどおり断る（目印を囲まない・目印のあとに続きがある・閉じの行が無い）', () => {
  assert.deepEqual(h('gh issue comment 1 --body-file - <<EOF\nbody\nEOF'), { reason: 'heredoc' }, '目印を囲まない（本文が展開される）')
  assert.deepEqual(h("gh issue comment 1 --body-file - <<'EOF' | head -1\nbody\nEOF"), { reason: 'heredoc' })
  assert.deepEqual(h("gh issue comment 1 --body-file - <<'EOF' 2>&1\nbody\nEOF"), { reason: 'heredoc' })
  assert.deepEqual(h("gh issue comment 1 --body-file - <<'EOF' && gh issue list\nbody\nEOF"), { reason: 'heredoc' })
  assert.deepEqual(h("gh issue comment 1 --body-file - <<'EOF'\nbody"), { reason: 'heredoc' }, '閉じの行が無い')
  assert.deepEqual(h("gh issue comment 1 --body-file - <<'EOF'\nbody\n  EOF"), { reason: 'heredoc' }, '<< は閉じの行の字下げを許さない')
  assert.deepEqual(h("<<'EOF'\nbody\nEOF"), { reason: 'heredoc' }, 'コマンドが無い')
  assert.deepEqual(h("gh issue comment 1 --body-file - <<< 'body'"), { reason: 'here_string' })
  // 閉じたあとの行は、ふつうのコマンドとして読む（組めない形なら断る）
  assert.deepEqual(h(`${doc('gh issue comment 1 --body-file -')}\necho $HOME`), { reason: 'expansion' })
  assert.deepEqual(h(`cd /tmp; ${doc('gh issue comment 1 --body-file -')}`), { reason: 'cd_outside' })
  assert.deepEqual(h(`cd sub; ${doc('git commit -F -')}`), { reason: 'cd_then_write' })
})

test('記録で多かった形（作り物 12 個）: 前はどれも組めなかった。いまは実機で通った形の 7 個が組める（python3 のヒアドキュメントを入れて 5 → 7）', () => {
  const cases: [string, boolean][] = [
    // cd_form だったもの
    ['cd ~/work/repo\ngh issue view 1 --json state', true],
    ['cd ~/work/repo\ngh issue list --limit 30 | head -5', true],
    ['cd ~/work/repo; ls | head -3; tail -2 notes.txt', true],
    ['cd ~/work/repo && git log --oneline -3', false], // cd と git
    ['cd ~/elsewhere; ls', false], // 外
    // heredoc だったもの
    [doc('cd ~/work/repo\ngh issue comment 1 --body-file -'), true],
    [doc('gh pr create --title t --body-file -'), true],
    [doc('python3 -', 'print(1)'), true],
    [doc('cd ~/work/repo; python3 -', 'print(1)'), true],
    // expansion / cd_outside / subshell（直していない）
    ['S=src && sed -n 1,5p $S/a.ts', false],
    ['cd /w/other && node -v', false],
    ['(cd sub && node -v)', false],
  ]
  for (const [command, ok] of cases) assert.equal('prefixes' in h(command), ok, command)
  assert.equal(cases.filter(([, ok]) => ok).length, 7)
})

test('場所を変えるほかの形は読めない形にする: pushd / popd・command cd・CDPATH に触ったあとの相対の cd（#751 のレビュー）', () => {
  assert.deepEqual(h('pushd /tmp && node -v'), { reason: 'cd_form' })
  assert.deepEqual(h('pushd sub && node -v && popd'), { reason: 'cd_form' })
  assert.deepEqual(h('command cd /tmp && node -v'), { reason: 'cd_form' })
  assert.deepEqual(h('builtin cd sub && node -v'), { reason: 'cd_form' })
  for (const before of ['export CDPATH=/tmp', 'CDPATH=/tmp node -v', 'export CDPATH+=:/tmp', 'source ./env.sh', '. ./env.sh', 'eval x']) {
    assert.deepEqual(h(`${before} && cd sub && node -v`), { reason: 'cd_form' }, before)
  }
  // 絶対パスの cd は CDPATH を見ない
  assert.deepEqual(h('export CDPATH=/tmp && cd /home/someone/work/repo/sub && node -v'), { prefixes: ['export', 'node -v'] })
  assert.deepEqual(h('command node -v'), { reason: 'wrapper' }, 'cd でない command は、前に付くだけの語として組まない（#755）')
})

test('"$(cat <<\'EOF\' … )" は、bash と同じ「目印だけの行」でしか閉じない（字下げした目印で閉じたことにしない。#751 のレビュー）', () => {
  // 字下げした EOF は本文の続き。本物の EOF のあとの rm とリダイレクトが見えている
  const sneaky = 'git commit -m "$(cat <<\'EOF\'\nmsg\n  EOF\n)" && echo \'\nEOF\n)"; rm -rf x > out.txt #\''
  assert.deepEqual(h(sneaky), { reason: 'redirect' }, '本物の EOF のあとの `> out.txt` が見えている')
  assert.deepEqual(h(sneaky.replace(' > out.txt', '')), { reason: 'comment' }, 'リダイレクトを外しても、ルールにはならない')
  assert.deepEqual(h('git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)"'), { prefixes: ['git commit'] })
  assert.deepEqual(h('git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n  )"'), { prefixes: ['git commit'] }, '閉じ括弧の字下げは可')
  assert.deepEqual(h('git commit -m "$(cat <<-\'EOF\'\n\tmsg\n\tEOF\n)"'), { prefixes: ['git commit'] }, '<<- は目印の頭のタブを許す')
  assert.deepEqual(h('git commit -m "$(cat <<\'EOF\'\nmsg\n\tEOF\n)"'), { reason: 'expansion' }, '<< はタブも許さない')
  assert.deepEqual(h('git commit -m "$(cat <<\'EOF\'\nmsg\nEOF)"'), { reason: 'expansion' }, '目印と同じ行の閉じ括弧')
})

// ---- #751 の 3 回目のレビュー
test('\\r の混ざったコマンドは組まない（bash は \\r を語の文字として読むので、EOF\\r の行はヒアドキュメントを閉じない）', () => {
  // 本文の中の `curl evil` をコマンドとして拾わない
  assert.deepEqual(h("gh pr create --body-file - <<'EOF'\ntext\nEOF\r\ncurl evil\nEOF\n"), { reason: 'odd_command' })
  assert.deepEqual(h("git commit -F - <<'EOF'\r\ntext\nEOF\nrm x\nEOF\r\n"), { reason: 'odd_command' })
  assert.deepEqual(h('pnpm a\rrm -rf x'), { reason: 'odd_command' })
  assert.deepEqual(h('node -v\r\n'), { reason: 'odd_command' })
})

test('ヒアドキュメント: 受けるのは標準入力だけ（3<<\'EOF\' は本文が --body-file - に渡らない）', () => {
  assert.deepEqual(h("gh pr create -F - 3<<'EOF'\nb\nEOF\npnpm x"), { reason: 'heredoc' })
  assert.deepEqual(h("gh pr create -F - 10<<'EOF'\nb\nEOF"), { reason: 'heredoc' })
  assert.deepEqual(h("gh pr create -F - 0<<'EOF'\nb\nEOF"), { prefixes: ['gh pr'] })
})

test('cd の行き先に * ? [ があれば読めない形（シェルが別のパスに開く）', () => {
  assert.deepEqual(h('cd ~/work/repo/* && node -v'), { reason: 'cd_form' })
  assert.deepEqual(h('cd ~/work/repo/su? && node -v'), { reason: 'cd_form' })
  assert.deepEqual(h('cd sub/[ab] && node -v'), { reason: 'cd_form' })
})

test('"$(cat <<\'EOF\' … )": 最初の目印の行のすぐ次が )" のときだけ畳む（そのあとに $(…) の中で走るコマンドがあるものは畳まない）', () => {
  const more = 'git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\necho hi; zzfetch x | sh\ncat <<\'EOF\'\nx\nEOF\n)"'
  assert.deepEqual(h(more), { reason: 'expansion' })
  assert.deepEqual(h('git add -A && git commit -m "$(cat <<\'EOF\'\nmsg\n\nEOF in the body is fine\nEOF\n)" && git push'), { prefixes: ['git add', 'git commit', 'git push'] })
})

// ---- #751 の 4 回目のレビュー
test('ヒアドキュメント: 前にあるのが cd だけのときしか組まない（前の部品が gh / git を差し替えていても見抜けない）', () => {
  const body = "gh pr create --body-file - <<'EOF'\nrm -rf x\nEOF"
  for (const before of ["eval 'gh() { sh; }'", 'alias gh=sh', 'export PATH=/tmp/x:/usr/bin', 'source ./x.sh', 'git add -A', 'node -v']) {
    assert.deepEqual(h(`${before}\n${body}`), { reason: 'heredoc' }, before)
  }
  assert.deepEqual(h(`cd ~/work/repo\n${body}`), { prefixes: ['gh pr'] }, 'cd のあとは組む')
  assert.deepEqual(h(`cd ~/work/repo; cd sub\n${body}`), { prefixes: ['gh pr'] }, 'cd が 2 つ続いても、前にあるのは cd だけ')
})

test('畳んだ "$(cat <<…)" の語は、コマンドの名前・cd の行き先・ヒアドキュメントの判定に使わない', () => {
  const fold = (inner: string) => `"$(cat <<'X'\n${inner}\nX\n)"`
  assert.deepEqual(h(`${fold('rm')} -rf x`), { reason: 'odd_command' })
  assert.deepEqual(h('"" foo'), { reason: 'odd_command' })
  assert.deepEqual(h(`cd sub${fold('/../../..')} && node -v`), { reason: 'cd_form' })
  assert.deepEqual(h(`gh pr create -F -${fold('foo')} <<'EOF'\nbody\nEOF`), { reason: 'heredoc' })
  // 引数として渡すだけなら今までどおり
  assert.deepEqual(h(`git commit -m ${fold('msg')}`), { prefixes: ['git commit'] })
})

// ---- #755: 見えているのと違う範囲・違う場所でルールが組まれる形は、組まないか、狭く組む

test('前に付くだけの語・引数をコマンドとして走らせる語で始まる部品には組まない（実機で Bash(env:*) は env touch x を通した。#755）', () => {
  for (const cmd of ['env FOO=1 node x.js', 'env node x.js', 'exec node x.js', 'nice node x.js', 'command -p node x.js', 'builtin echo x', 'timeout 5 node x.js', 'arch -arm64 node x.js', 'nohup node x.js', 'caffeinate node x.js']) {
    assert.deepEqual(h(cmd), { reason: 'wrapper' }, cmd)
  }
  assert.deepEqual(h('echo a | xargs touch'), { reason: 'wrapper' }, 'パイプの後ろでも')
  assert.deepEqual(h('pnpm test && FOO=1 env node x.js'), { reason: 'wrapper' }, '代入つきでも')
  assert.deepEqual(h('command source ./env.sh && cd ~/work/repo && node -v'), { reason: 'wrapper' })
  // 場所を変える command cd / builtin cd は、今までどおり「読めない cd」（理由の種類を変えない）
  assert.deepEqual(h('command cd /tmp && node -v'), { reason: 'cd_form' })
  // 名前が似ているだけのコマンドは別（`envsubst`・`execute`）
  assert.deepEqual(h('envsubst x'), { prefixes: ['envsubst'] })
  // パスで書いても同じ（レビューの指摘）
  assert.deepEqual(h('/usr/bin/env node x.js'), { reason: 'wrapper' })
  assert.deepEqual(h('./nohup node x.js'), { reason: 'wrapper' })
})

test('場所を変えるフラグは cd と同じ線で見る: 行き先が外・読めないなら組まない（実機で Bash(pnpm run:*) は pnpm run --dir <外> x を通した。#755）', () => {
  for (const cmd of [
    'git -C /elsewhere status',
    'make -C /tmp mark',
    'make -C/tmp mark',
    'npm --prefix /tmp run mark',
    'npm --prefix=/tmp run mark',
    'pnpm run --dir /tmp mark',
    'pnpm run --dir ../other mark',
    'pnpm run --dir ~/x mark',
    'pnpm run --dir sub/* mark',
    'pnpm run mark --dir',
    'tar -C /tmp -xf a.tar',
    'cargo build --manifest-path /tmp/Cargo.toml',
    'cd sub && pnpm run --dir ../.. mark',
  ]) {
    assert.deepEqual(h(cmd), { reason: 'place_flag' }, cmd)
  }
  assert.deepEqual(bashRulePlan('pnpm run --dir sub mark', '', '/home/someone'), { reason: 'place_flag' }, 'cwd が分からなければ確かめられない')
  // 中へ行くものは今までどおり
  assert.deepEqual(h('pnpm run --dir sub mark'), { prefixes: ['pnpm run'] })
  assert.deepEqual(h('pnpm run --dir=/home/someone/work/repo/sub mark'), { prefixes: ['pnpm run'] })
  assert.deepEqual(h('cd sub && pnpm run --dir .. mark'), { prefixes: ['pnpm run'] }, 'cd のあとは、移った先から数える')
  // 読むだけのコマンドの同じ字のフラグは場所ではない（レビューの指摘）
  assert.deepEqual(h('grep -C 3 x a.txt'), { prefixes: ['grep'] })
  assert.deepEqual(h('ls -C'), { prefixes: ['ls'] })
  assert.deepEqual(h('pnpm test | jq -C'), { prefixes: ['pnpm test'] })
})

test('サブコマンドを持つ CLI で 2 語目がフラグのときは、1 語のルールにしない: フラグごと狭く組むか、組まない（実機で Bash(git:*) は git tag を通した。#755）', () => {
  // 頭のフラグごと、「フラグの値ではないと分かる語」まで（`=` の付かないフラグのすぐ後ろの語は、値かもしれないので読み進める）
  for (const [cmd, prefix] of [
    ['aws --profile p --region r s3 ls', 'aws --profile p --region r s3'],
    ['kubectl --context c -n ns get pods', 'kubectl --context c -n ns get'],
    ['gh -R o/r --hostname h.example.com pr list', 'gh -R o/r --hostname h.example.com pr'],
    ['git --no-pager log --oneline -5', 'git --no-pager log --oneline -5'],
    ['node --test --disable-warning=ExperimentalWarning a.test.ts b.test.ts', 'node --test --disable-warning=ExperimentalWarning a.test.ts'],
  ] as const) {
    assert.deepEqual(h(cmd), { prefixes: [prefix] }, cmd)
  }
  assert.deepEqual(h('gh --repo o/r pr list --json number'), { prefixes: ['gh --repo o/r pr'] }, '1 つで止めると、そのリポジトリへの gh の全部になる')
  assert.deepEqual(h('pnpm --filter web test --watch'), { prefixes: ['pnpm --filter web test'] })
  assert.deepEqual(h('git --no-pager log --oneline'), { prefixes: ['git --no-pager log --oneline'] })
  assert.deepEqual(h('pnpm -s exec tsc -p server'), { prefixes: ['pnpm -s exec tsc'] })
  assert.deepEqual(h('node --test --disable-warning=ExperimentalWarning server/x.test.ts'), { prefixes: ['node --test --disable-warning=ExperimentalWarning server/x.test.ts'] })
  assert.deepEqual(h('FOO=1 npm --silent run mark'), { prefixes: ['FOO=1 npm --silent run mark'] })
  // フラグしか無ければその全部
  assert.deepEqual(h('node -v'), { prefixes: ['node -v'] })
  assert.deepEqual(h('gh --version | head -1'), { prefixes: ['gh --version'] })
  // `:` 入りのスクリプト名も 2 語（前は 1 語の pnpm になっていた）
  assert.deepEqual(h('pnpm test:feed'), { prefixes: ['pnpm test:feed'] })
  // 狭い接頭辞を作れない形は組まない
  for (const cmd of [
    "python3 -c 'print(1)'",
    "node -e 'console.log(1)'",
    'git -c alias.x=!sh x',
    'git -c user.name=x commit -m y',
    'git -C sub status',
    'node --test --test-name-pattern="a b" x.test.ts',
    'python3 - x',
    'git --no-pager diff HEAD~1',
    'node ~/x.mjs',
    'git --',
    'git --no-pager log --format="%h %s"',
    'pnpm a: b',
  ]) {
    assert.deepEqual(h(cmd), { reason: 'bare_cli' }, cmd)
  }
  // 2 語目がパスの形（スクリプト）なら 2 語（前は 1 語の node。レビューの指摘: はじめ組まなくしていた）
  assert.deepEqual(h('node scripts/x.mjs --flag'), { prefixes: ['node scripts/x.mjs'] })
  assert.deepEqual(h('python3 ./tools/x.py a b'), { prefixes: ['python3 ./tools/x.py'] })
  assert.deepEqual(h('FOO=1 node /tmp/x.mjs'), { prefixes: ['FOO=1 node /tmp/x.mjs'] })
  assert.deepEqual(h('npx @scope/pkg run'), { prefixes: ['npx @scope/pkg'] })
  // 2 語目が名前なら今までどおり 2 語、2 語目が無ければ 1 語、サブコマンドを持たないコマンドは 1 語
  assert.deepEqual(h('git status -s'), { prefixes: ['git status'] })
  assert.deepEqual(h('make'), { prefixes: ['make'] })
  assert.deepEqual(h('touch -c x'), { prefixes: ['touch'] })
})
