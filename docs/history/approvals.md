# 許可と Jevの経緯

なぜ今の形になったか（前はどうだったか・実測・レビューの指摘）。仕組みは [internals/approvals.md](../internals/approvals.md)。新しい経緯はこのファイルの該当する節に足す。

## 返信中の許可・質問

### 質問のバブルは実際に出る

- `AskUserQuestion` / `ExitPlanMode` が `-p` に出るのは `--permission-prompt-tool` を付けているから（2.1.266 で実測。素の `-p` では出ない）なので、質問のバブルは飾りではなく実際に出る。測り方と詳細は [design-notes.md](../design-notes.md)。

### 許可した回数を数える（#445）

- 素通し（`bypassPermissions`）が増えた理由は「`acceptEdits` だと同じ許可を毎ターン聞かれる」で、[常に許可] はあっても、どれをルールにすれば聞かれなくなるかを人が覚えていなかった。それで回数を数えて勧める。
- issue の案は `approval-counts.json`（集計だけ）だったが、**答えるたびに 1 行足す `approvals.jsonl`** にして、回数はそこから数え直す形にした。#582（素通し無しでどれくらい聞かれるかを測る）が同じ記録（誰が答えたか・待った秒数）を要るので、数える材料を 2 つ持たないため。
- Jev の自動の許可も記録には足すが、勧める回数には数えない（人が押した回数ではない。自動のほうはその場でルールを書く）。
- #621 のレビュー: 盾の「よく許可しているが、ルールに無いもの」は表記が同じルールしか外していなかったので、あとから広いルール（`Bash(gh:*)`）を足しても 30 日のあいだ `Bash(gh pr:*)` が並び続けた。覆われているかで外すようにした。

### つないだコマンドの [常に許可] が効かなかった（#705）

- 前は `&&` や `|` の**手前まで**の先頭の語だけでルールを作っていた（`cd dir && pnpm test` → `Bash(cd:*)`）。Claude Code はつないだコマンドを部品ごとに見るので後ろが通らず、押しても次も聞かれた。記録（10/2〜10/5 の `approvals.jsonl`）では Bash の許可 69 件のうち `Bash(cd:*)` が 31 件で、ある worktree では [常に許可] を 11 回押したあとも 20 回聞かれていた。`Bash(for:*)` も 7 件あった。
- 実装の前に実機で形を試した（Claude Code 2.1.287。捨てのディレクトリで `claude -p "<文>" --model haiku --setting-sources project --output-format json --allowedTools "<ルール>"`、`permission_denials` で判定。各 1 回）:

| 実行したコマンド | 許可していたルール | 結果 |
| --- | --- | --- |
| `touch x && mkdir d` / `touch a; mkdir b` / `touch a && mkdir b \|\| rm -f c` | 部品の全部 | 通る |
| `touch x && mkdir d` / 改行でつないだ `touch a` と `mkdir b` | `Bash(touch:*)` だけ | 断られる |
| `node -v \| tee v.txt` / `touch p1 \| tee p2` | 前だけ | 断られる |
| 同じ | 前と `Bash(tee:*)` | 通る（**パイプの後ろも部品**） |
| `node -v \| head -1`（`tail` / `grep` / `wc` / `sort \| uniq` / `cat` / `cut \| tr` / `sed -n 1p` / `xargs echo` / `jq`）、`node -v && echo done`、`node -v; pwd; ls`、`\|\| true`、`&& sleep 1 && date`、`&& which node` | `Bash(node:*)` だけ | 通る（読むだけのコマンドはルールが要らない） |
| `node -v \| awk "{print}"` | `Bash(node:*)` だけ | 断られる |
| `cd sub` | 関係ないルールだけ | 通る |
| `cd sub && node -v` | `Bash(node:*)` だけ | 通る（**中への `cd` はルールが要らない**） |
| `cd /tmp && node -v` / `cd ../.. && node -v` | `Bash(cd:*)` と `Bash(node:*)` | 断られる（**外への `cd` はルールがあっても聞かれる**） |
| `cd sub && touch x`（`;` でも・順が逆でも・`mkdir` / `rm` / `cp` / `mv` / `sed -i` / `tee` でも） | `Bash(cd:*)` と後ろのルール | 断られる |
| `cd sub && git status` / `cd sub && pnpm -v && git status` | 全部 | 断られる |
| `cd sub && node -v`（`npm` / `pnpm` / `make` / `cat` / `chmod +x f` / `ln -s a b` / `python3 -c …`）、`cd sub && pnpm -v \| tail -5` | `Bash(cd:*)` と後ろのルール | 通る |
| `echo hi > y.txt` / `node -v > out.txt` / `cd sub && node -v > out.txt` | コマンドのルール | 断られる |
| `node -v 2>&1` / `2>/dev/null` / `>/dev/null` / `touch x < /dev/null` | コマンドのルール | 通る |
| `FOO=1 touch x` | `Bash(touch:*)` | 断られる |
| `FOO=1 touch x` / `FOO=1 BAR=2 touch x` / `NODE_ENV=test touch x` | 代入ごとのルール（`Bash(FOO=1 touch:*)`） | 通る |
| `touch $(echo x)` / `touch "$(echo x)"` / `` touch `echo x` `` / `touch "$PWD/x"` / `touch x$FOO` / `touch a{1,2}` | `Bash(touch:*)` | 断られる |
| `touch "$(cat <<'EOF' … EOF)"` / `git commit -m "$(cat <<'EOF' … EOF)"` | コマンドのルール | 通る |
| `for i in 1 2; do touch $i; done` / `(touch a && mkdir b)` / `touch a && { mkdir b; }` / `node -v & touch x` | 出てくる語の全部 | 断られる |
| `touch "a && b"` / 行の頭の `# コメント` のあとの `touch x` | `Bash(touch:*)` | 通る |

- `cd` のあとの書き込みが断られるのは Claude Code の意図した動き（本体の文言は「Compound command contains cd with write operation - manual approval required to prevent path resolution bypass」。`git` は「Compound commands with cd and git require approval to prevent bare repository attacks」）。書き込み扱いの並び（`mkdir` / `touch` / `rm` / `rmdir` / `mv` / `cp` / `sed` / `tee`）は本体の分類から取り、表の結果と合っている。
- issue の案は「`cd dir && pnpm test` → `Bash(cd:*)` と `Bash(pnpm test:*)`」だったが、**`Bash(cd:*)` は書かない**ことにした。表のとおり一度も効かない（中はルール無しで通り、外はルールがあっても聞かれる）ので、許可の範囲を広げるだけになる。案 4（`cd` だけのときは勧めない）は、書くルールが無いので [常に許可] が出ない、という形で満たした。前の記録に残っている `Bash(cd:*)` は盾のモーダルの「よく許可しているが、ルールに無いもの」から外した。設定にもう書かれている `Bash(cd:*)` は消していない（害が無く、SAI は設定を「常に許可」の経路でしか書かない）。
- 読むだけのコマンド（`UNASKED`）は、通ると確かめたものだけを並べた。書いても害は無いが、許可の範囲は聞かれるものだけにしたかった。ここに無い読むだけのコマンドは書く側に倒れる。
- #710 のレビュー: 読むだけのコマンドを名前だけで飛ばすと、`cat /etc/hosts` のように引数しだいで聞かれた単体のコマンドから [常に許可] が消えた（前は出ていた）。ほかに書くルールが無いときは、その部品に書くようにした。`pnpm test | sort -o out.txt` のように、ほかにルールがあって読むだけのコマンドの側も聞かれる形は残っている（押しても次も聞かれうる。危ない方向ではない）。同じレビューで、`\\` で終わるコメント行の次の行を捨てていたのも直した（行の継続を先に空白へ置き換えていた）。
- 回数の鍵を「書かれるルールの組」にしたので、同じコマンドでも設定にルールが足されると鍵が変わる（`Bash(a:*) + Bash(b:*)` → `Bash(a:*)`）。数えているのは「押すと何が書かれるか」なので、それでよいとした。
- 通しでも確かめた（捨てのサーバと本物の `claude`）: `cd sub && node -v && npm -v | tail -1` のバブルに `Bash(node:*)` と `Bash(npm:*)` が並び、[常に許可] で 2 つとも `.claude/settings.local.json` に書かれ、次の `cd sub && npm -v && node -v | tail -1` は聞かれなかった。

## Jev

### Claude の要約を送らない（#493 のレビュー）

- Claude の要約（`approvalText()`）は送らない——MCP のツールなどでは input の JSON がそのまま入るため。

### 聞く文を英語にした

- 聞く文は英語の 1 文（`JEV_SAFE_STATEMENT`）。ベンダーが日本語は精度が落ちると言っている。
- 作りもの 7 件で `git status` 0.97 / `rm -rf ~/` 0.01 と分かれることを確かめた（ほかの値は [screen.md](../screen.md)）。

### 忘れる時刻を「見なくなってから」にした

- 見かけるたびに時刻を進める。進めないと、長く待っている許可を 30 分ごとに聞き直す。

### `createApp` の既定を「送らない」にした

- 既定で環境から組むと、鍵のあるマシンでテストを回したときに本物へ送る。

## 自動で「常に許可」（#499）

### 読む経路からは動かさない

- 一覧のポーリングや MCP の `sai_sessions` が許可を書いてはいけない。`approvalsNow()` からは動かさず、`jevAutoTick()` を別に呼ぶので、タブが無くても動く。

### Bash だけにした

- MCP ツールは `jevState()` が引数を送らないので、許すと Jev が見ていないものを永久に許すことになる。

### ルールを聞く文を変えた（#553）

- 実測（2026-09-30）でルールの確率はこの回よりずっと低く出た（`git status` 97% / `Bash(git status:*)` 76%、`pnpm test` 87% / 19%、`gh pr view` 97% / `Bash(gh pr:*)` 16%）ので、閾値 80% では 1 度も答えていなかった。
- そこでルールを聞く文を「当たるコマンドのどれも壊さない」ではなく「普段の作業（調べる・ビルド・テスト）の範囲として許してよいか」にした（`JEV_RULE_STATEMENT`）。聞き比べで `Bash(git status:*)` 93% / `Bash(pnpm test:*)` 88% / `Bash(ls:*)` 82% / `Bash(gh pr:*)` 72% / `Bash(git push:*)` 13% / `Bash(rm:*)` 22%。消す・出す・漏らすルールは低いまま。
- 同時に、答えない理由を `reply.log` に残し（同じ許可に 1 行だけ）、ルールの確率を `Approval.jev_rule` としてバブルにも出すようにした。

## 答えた許可を残す・端末で打った Codex の「処理中」（#693）

- Codex が許可で止まって SAI で答えると、バブルが消えたあとターンが終わるまで画面に何も出ず、何も進んでいないように見えた。原因は 2 つ: 端末で打った Codex のターンには「処理中」が出ない（出す条件が「SAI が起こした返信」か「入力の行のあと」で、Codex は入力の行を書かない）ことと、答えた許可の記録がどこにも無い（バブルは「いま待っているもの」から毎回作る。Claude はフックの待ちの行が残るが、Codex にはフックが無い）こと
- 行（JSONL）に書く案は採らなかった。`record.py` と行の形を触ることになり、SAI が行を起こさない決まりにも反する。メモリに置き、ターンが終わったら出さない（終わったターンのコマンドは #605 の「手順」に出る）
- #695 のレビューで 2 つ直した: `codexProgress()` が `turn_aborted` を見ておらず、Esc で止めた Codex のターンが最後の書き込みから 10 分「処理中」のままになる（実物の rollout 3 本で再現。`codexQueue.ts` と `codexImages.ts` は前から閉じる印として見ていた）。答えた許可を片付けるのがターン完了の行だけで、止めたターンで答えたものが次のターンの「処理中」の上に残る（閉じた時刻と、次のターンの始まりでも片付ける。行は秒までなので同じ秒も片付ける）
- 一覧（サイドバー）とフィードには出していない。出すには全セッションの rollout を読むことになる

## ルールが空だった理由を記録に足す（#724）

- #710 のあと、人が答えた Bash の許可の 9 割（73 件中 66 件）で `rule` が空になった。コマンドは記録に書かない決まりなので、「組めなかった」のか「組めたが全部もう設定にあった」のか、組めなかったならどの形かが分からなかった
- 判定は変えず、`null` を返していた所に種類の名前を付けただけ。溜めてから多い順に直す
- **サブディレクトリの `cwd`（実測 2.1.292、作り物のリポジトリで各 1 回）**: git の根より深いディレクトリで `claude -p` を起こすと、**そのディレクトリの `.claude/settings.local.json` と、git の根の `.claude/settings.local.json` の両方**の許可が効いた。途中のディレクトリのもの・git の根より上のもの・根の `.claude/settings.json` は効かなかった。根で起こすと、下のディレクトリのものは効かない
- SAI が読むのは `<セッションの cwd>/.claude/` だけなので、深い `cwd` のセッションでは**根の `settings.local.json` にあるルールを見落とす**（盾のモーダルに出ない・もう効いているルールを [常に許可] に並べる）。これは `rule` が空になる向きとは逆で、空の原因としては再現しなかった。直していない

