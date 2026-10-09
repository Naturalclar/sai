# 許可と Jevの仕組み

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/approvals.md](../history/approvals.md)。

画面から見た動き（許可・質問のバブル、キーボード、[常に許可]、盾のアイコン、Jev の表示と「自動で常に許可」）は [screen.md](../screen.md) の「返信と許可」と「許可して問題なさそうかの予想（Jev。#491）」、口の形は [api.md](../api.md)。ここにはコードの側の話を置く。

## 返信中の許可・質問

### MCP サーバと預かり

- 返信の `claude` に `--mcp-config` で足す SAI の MCP サーバは `server/approvals/approve-mcp.ts`（stdio、依存ゼロ、`initialize` / `tools/list` / `tools/call` だけ）。`--permission-prompt-tool mcp__sai__approve` で許可が要るたびに呼ばれる。
- 預かりは `server/approvals/approvals.ts`（メモリと `approvals.json`）。プロセスが exit したら `drop`、90 秒取りに来なければ捨てる。
- `rev` に答え待ちの集合を混ぜるので画面のポーリングが拾う。
- Claude だけ（Codex に口が無い）。
- テストは `server/approvals/approve-mcp.test.ts` が実際に子プロセスを立てる。

### 待ちの文言と `dumpsLikePython()`

- 文言（`許可待ち: Bash: …`）は `shared/approvals.ts` で作り、`record.py` の待ちの行と揃える。
- 専用の要約が無いツール（MCP のツール、未知のツール）は `tool_input` をそのまま JSON にする。そのときは `JSON.stringify` ではなく `shared/pyjson.ts` の `dumpsLikePython()` を通す（#147）。Python の `json.dumps(..., ensure_ascii=False, sort_keys=True)` と同じ文字列になる: 区切りは `, ` / `: `、キーは入れ子の中までコードポイント順にソート。
- 揃っていることは `shared/approvals.test.ts` と `feed/test_record.py` に同じ入力と同じ期待文字列を置いて留める（片方だけ変えるともう片方が落ちる）。

### キーボード

- 判定は `web/src/approvalKeys.ts` の `approvalAction()`。
- 受けるのは描画順の先頭のバブルだけで、親（`FeedView` / `SessionView`）が `hotkey` を渡して決める。
- window の keydown を capture で張り、拾ったときだけ `stopPropagation()` する。

### 質問（`AskUserQuestion`）

- 画面は `web/src/AskQuestions.tsx`。組み立てと答えの組み方は `shared/approvals.ts` の `askQuestions` / `joinAnswer` / `answersReady`（全問そろってから 1 回で送る）。

### 「常に許可」

- 画面は `remember: 'local'` だけを送り、サーバが `app.ts` の `alwaysRules()` でルール（`Bash(gh pr:*)` など）を組み立てて、`updatedPermissions`（`destination: localSettings`。`permissionsFor()`）として CLI に返す。CLI が cwd の `.claude/settings.local.json` に書く。
- **ルールを組むのは `alwaysRules()` の 1 つだけ**（#705）。画面に出す `Approval.always`・回数の鍵・人の答え・Jev の自動が同じものを見る。中身は `shared/approvals.ts` の `alwaysAllowRules()`（Bash は `shared/bashRules.ts` の `bashRulePrefixes()` が部品ごとの接頭辞を返す。null なら出さない）から、もう設定にあるもの（`ruleCovered()`）を除いたもの。空なら [常に許可] を出さず、`remember: 'local'` は `400`。
- `bashRulePrefixes(command, cwd, home)`: `&&` / `||` / `;` / 改行 / `|` で部品に分け、部品ごとに「環境変数の代入 + 先頭 1 語（`SUBCOMMAND_CLIS` は 2 語）」を返す。`cd` と `UNASKED`（読むだけのコマンド）には作らない（ほかに書くルールが 1 つも無いときは `UNASKED` の部品に作る。引数しだいで聞かれるので）。null にするのは、切れない・通らない形（展開・波括弧・サブシェル・`KEYWORDS`・ファイルへのリダイレクト・`&`・行の途中の `#`・閉じていない引用符）、`cd` の行き先が `cwd` の外か `cwd` が分からないとき、`cd` と `NOT_AFTER_CD`（書き込み系と `git`）をつないだとき。
  - `cd ~/…`（#724）: サーバが渡すホーム（第 3 引数。**省略不可**で、本物を渡すのは `app.ts` の `alwaysPlan()` だけ）に読み替えてから、ほかの `cd` と同じに見る（中なら通す・外なら `cd_outside`）。**読み替えるのはコマンドの最初の部品のときだけ**（前に何かあると、そこで `HOME` が変わっていても見抜けない）。ホームが空・`~user`・引用符やバックスラッシュの付いた `~`（bash は展開しない）も `cd_form` のまま。
  - 空の語（`""`）と、畳んだ `"$(cat <<…)"` の語は、コマンドの名前（`odd_command`）にも `cd` の行き先（`cd_form`）にも使わない（中身を読んでいない）。
  - `\r` の混ざったコマンドは組まない（`odd_command`。bash は `\r` を語の文字として読むので、空白や改行として読むと本文の中の文字をコマンドとして拾う）。`cd` の行き先に `*` `?` `[` があるものは `cd_form`。ヒアドキュメントを受けるのは標準入力（fd なしか `0`）だけ。本文の閉じの行の探し方は `heredocBodyEnd()` の 1 つ（最初の「目印だけの行」）。
  - 場所を変えるほかの形も `cd_form`: `pushd` / `popd`・`command cd`・`builtin cd`・`CDPATH` に触った部品や `source` / `.` / `eval` のあとの相対の `cd`。
  - **前に付くだけの語**（`WRAPPERS`: `env`・`command`・`exec`・`nice`・`timeout`・`arch` など）と**引数をコマンドとして走らせる語**（`ARG_RUNNERS`: `nohup`・`xargs`）で始まる部品には組まない（`wrapper`。#755。パスで書いた `/usr/bin/env` も basename で見る）。その語のルールは、後ろの何でも通すか（`env`・`nice`）、書いても効かない（`command`）。`WRAPPERS` は自動の「今回だけ許可」で通さない形（#749）と同じ 1 つを使う。
  - **場所を変えるフラグ**（`PLACE_FLAGS`: `-C`・`--dir`・`--prefix`・`--cwd` など。`--dir=x`・くっつけた `-Cx` も。`placeTargets()`）は、`cd` と同じ線で見る（#755）: 行き先が `cwd` の外・読めない（語が無い・`~`・`*` `?` `[`・畳んだ語・`cwd` が分からない）なら `place_flag`。中なら今までどおり組む。`UNASKED`（読むだけのコマンド）の同じ字のフラグは見ない（`ls -C`・`jq -C`）。ほかはコマンドの種類を見ない（`git diff -C` も断る側）。
  - **サブコマンドを持つ CLI で 2 語目がフラグのときは、1 語のルールにしない**（`ruleHead()`。#755）。頭のフラグごと、「フラグの値ではないと分かる語」（語か `--x=値` のすぐ後ろの、名前・パスの形の語）か部品の終わりまでを接頭辞にする（`git --no-pager log --oneline`・`pnpm -s exec tsc`・`gh --repo o/r pr`・`node -v`。`=` の付かないフラグのすぐ後ろの語は値かもしれないので、そこでは止めない）。途中にその形でない語がある（`python3 -c '…'`・`git -c a.b=c …`）・頭に場所を変えるフラグがある（`git -C sub status`）なら `bare_cli`。`:` 入りのスクリプト名（`pnpm test:feed`）とパスの形（`node scripts/x.mjs`）は 2 語にする。2 語目が無いとき（`make` だけ）は 1 語のまま。
  - 引用符つきの目印のヒアドキュメント（`<<'EOF'` / `<<"EOF"` / `<<-'EOF'`。#724）: **目印がその行の最後**で、閉じの行があり、渡す先が `takesHeredoc()` の形のときだけ、本文を読み飛ばして組む。形は 3 つ: `gh issue|pr|release create|comment|edit|review … --body-file -`（`-F -` も）と `git commit … -F -`（`--file -` も）、**`python3`**（#724 の人の決定）。先頭の語だけでは決めない（`git apply <<'EOF'`・`gh auth login --with-token <<'EOF'`・`git -c … <<'EOF'` は本文を操作やコードとして受け取る）。**前にある部品が `cd` だけのとき**しか組まない（前の部品が `gh` / `git` の実体を差し替えていても見抜けない: `eval 'gh() { sh; }'`・`alias gh=sh`・`export PATH=…`）。畳んだ `"$(cat <<…)"` の語が混ざった部品も組まない。閉じの行の次からは、ふつうのコマンドとして読む。それ以外（目印を囲んでいない・目印のあとに `|` や `2>&1` や `&&` が続く・`node - <<'EOF'` や `bash <<'EOF'` のように `python3` 以外でコードを受け取る）は、その場で `heredoc`（あとの行の理由より先に返す）。
  - **1 語のルールを書く例外は 1 か所**（`python3HeredocRule()`。#724）: ヒアドキュメントを受けた部品が「標準入力からプログラムを読む `python3`」（`python3`・`python3 -`・`python3 -u -`・`python3 - a b`）のときだけ、`ruleHead()` を通さず `Bash(python3:*)` を書く。人が、**python3 で始まるコマンド全部に効く**ことを分かったうえで決めた。それ以外の `python3` のヒアドキュメント（`python3 -c '…' <<'EOF'`・`python3 -m x <<'EOF'`・`python3 tool.py <<'EOF'`・値を取るフラグ `-W` / `-X` つき）は、実機で確かめていないので `heredoc` で断る（受ける条件と書くルールの条件は、同じ `python3HeredocRule()` の 1 つ）。目印の前に捨てるリダイレクトがある形（`python3 - 2>&1 <<'EOF'`）も断る。1 語の `python3` を書くときは、それに覆われる `python3 <何か>` のルールを並べない。ヒアドキュメントの無い、引数の無い `python3`（`cat a.py | python3`）は、前から `ruleHead()` が 1 語にしている（ここの例外ではない）。ヒアドキュメントの無い `python3 -c`・`python3 -`・`node -e` は #755 のとおり組まない。**不揃いが残る**: `python3 -c` には [常に許可] が出ないのに、ヒアドキュメントで 1 回押すと `python3 -c` も通る。
  - `"$(cat <<'EOF' … EOF)"` は、**走査の中で二重引用符に当たった位置でだけ**空の語として読む（全文に先に置換を掛けない。読み飛ばすヒアドキュメントの本文やコメントの中の同じ字面を畳んで、その間のコマンドを見落とすため）。本文は最初の「目印だけの行」（`<<-` のときだけ頭のタブ可）で閉じ、**そのすぐ次が `)"`** のときだけ畳む。
- もう設定にあるルールは `terminal.allowedRules`（`permissions.ts` の `allowRules()`。設定ファイルを読むだけ）から。**本物を読むのは `main.ts` だけ**で、`createApp` の既定は「読まない」（テストが回したマシンの設定で変わらないように）。
- 画面は `ApprovalBubble` が `approval.always` を `AlwaysRules` で並べる。下の文には、ルールが効く範囲を言葉でも書く（`shared/approvals.ts` の `ruleScope()`: `Bash(python3:*)` → 「python3」で始まるコマンド。#724。聞かれた 1 つより広いことを隠さない。`&&` や `|` でつないだ途中の部品にも効くことを、文の終わりに 1 回書く）。ボタンの title と回数の勧め（`countNote()`）も「この形」と言わず「下のルールの範囲」と言う。**画面はルールを組まないし送らない**。
- 入口は 2 つ: 人が押す [常に許可] と、Jev の自動の「常に許可」（#499。下の「自動で常に許可」）。

### 許可した回数と「常に許可」の勧め（#445）

- 記録は `server/approvals/approvalLog.ts` の `ApprovalLog`（`<feed dir>/approvals.jsonl`）。`answerApproval()` が Claude の許可に答えたときと、Jev の自動の「常に許可」（`jevAutoOnce()`）のあとに `logAnswer()` が 1 行足す（`ApprovalLogRow`: `ts` / `id` / `cwd` / `tool` / `rule` / `by` / `behavior` / `remember` / `waited_s`）。cwd はセッションの行から取り、コマンドの全文は書かない。Codex・OpenCode・端末のダイアログの答えは足さない。
- **答えたときの Jev の確率も残す**（#749。`jev` / `jev_none`）。`logAnswer()` が `JevRisk.peek(approval_id)`（聞いた控えを見るだけ。聞かない・覚えも延ばさない）を `shared/jev.ts` の `jevLogged()` に通す: 届いていれば `jev`（小数 3 桁に切り捨て。閾値と比べたときに、届いていなかったものを届いたと数えない）、無ければ `jev_none`（`not_asked` / `pending` / `failed`）。答えたときに Jev を切っていれば、前に聞いた控えが残っていても `not_asked`。控えはメモリだけなので、サーバを立て直したあとに答えた許可は聞き直しになる（届く前に答えれば `pending`）。確率は預かった入力に付けたもので、人が入力を変えて許可しても付け直さない。人が答えた行にも、Jev が自動で答えた行にも付く。足すのは数と種類だけで、コマンドの文字は書かない
- **`rule` が空の行には、空だった理由の種類 `no_rule` を添える**（#724。`NoRuleReason`）。Bash の形は `shared/bashRules.ts` の `bashRulePlan()` が返す（`bashRulePrefixes()` はこれを呼んで `null` に畳むだけなので、[常に許可] を出すかの判定と記録の理由は同じ 1 つ）。`cd` しか無い（`cd_only`）と Bash でないツール（`not_bash`）は `alwaysAllowPlan()`、組めたが全部もう設定にある（`covered`）は `app.ts` の `alwaysPlan()` が付ける。種類の全部は `shared/approvals.ts` の `NO_RULE_REASONS` で、`server/docs.test.ts` が `docs/data.md` の一覧と突き合わせる。**種類だけ**で、コマンドの文字・引数・パスは持たない。
- 回数は起動時にこのファイルを読み直して持つ（`countsTowardSuggest()`: 人が許可した・ルールがある・cwd が分かる行を、cwd とルールごとに直近 `APPROVAL_COUNT_DAYS`（30）日ぶん）。
- `approvalsNow()` が、ルールの作れる Claude の許可に `always`（書かれるルール）と、`count`（数えた回数 + 1）・`suggest`（`APPROVAL_SUGGEST_AT`（3）以上）を付ける。数える鍵は書かれるルールの組（`rulesKey()`。`Bash(a:*) + Bash(b:*)`。1 つならその表記のまま）で、記録の `rule` も同じ。鍵は**答える前に**組む（答えたあとは設定に書かれて空になる）。**付けるだけで、答えもルールも書かない**（読む経路なので）。
- 画面は `ApprovalBubble` が `countNote()` の 1 行を出し、`suggest` なら [常に許可] に `suggest` のクラスを付ける。盾のモーダルは `GET …/permissions` の `frequent`（`ApprovalLog.frequent()`。2 回以上で、許可のルールに覆われていないもの。`ruleCovered()` は同じ表記のほか、より広い Bash のルール（`Bash(gh:*)`）と別の書き方（`Bash(gh pr *)`）も覆っている扱いにする。組は `keyCovered()` で全部が覆われたときだけ外す）を上に出す。`Bash(cd:*)` だけの鍵（#705 より前の記録）は `neverSuggested()` で出さない。
- 人の答えは**記録に足してから**応答を返す（次のポーリングの「何回目」がずれない）。

### 答えた許可を残す（#693）

- `server/approvals/answered.ts` の `AnsweredApprovals`。`POST /api/approvals/<id>/answer` が通ったあと（端末の Codex のダイアログ・Codex app-server・OpenCode・Claude の `-p` のどれでも）、画面に出していた 1 行（`Approval.text`）と答えの向き・押した選択肢の文言を、セッションごとにメモリに覚える（`ANSWERED_MAX` 20 件・`ANSWERED_TTL_MS` 6 時間。**JSONL にも state にも書かない**。入力そのものは持たない）
- どのセッションの何だったかは `app.ts` の `shownApprovals`（`approvalsNow()` が画面に渡した許可を approval_id で覚える）から引く。選択肢の文言は提示した `decisions` から引き、リクエストの文字列は使わない
- 詳細（`GET /api/sessions/<id>`）は `answered.of(id, answeredAfter(…))` を `answered` に載せ、その並びを `rev` に混ぜる。`answeredAfter()` は「ここより前は終わったターン」の時刻で、最後のターン完了の行（行は秒までなので、その秒の終わり）・transcript / rollout の上でターンが閉じた時刻（Claude の `closed_at`、Codex の `turn_closed`。**止めたターンは行が来ない**）・Codex の開いているターンの始まり（`turn_since`）のうち一番新しいもの
- 画面は `AnsweredApprovals`（`SessionView` の trailer の先頭。「処理中」の上）。文言は `web/src/answeredLabels.ts` の `answeredLine()`

## セッションに効いている許可

- `server/approvals/permissions.ts` が cwd から読むだけ。書き換えは「常に許可」の経路だけ（人が押す `remember: 'local'` と、Jev の自動の `jevAutoTick()`）。
- 読む先と評価の順は screen.md。パスは cwd から固定で組み立て、リクエストからは受け取らない。
- 並びと言い換えは `shared/permissions.ts`（評価は deny → ask → allow で、deny はどのスコープでも allow に勝つ）。
- 行の `permission_mode`（Claude のフックのペイロード）を `aggregate.ts` が `SessionSummary.permission_mode` に出す。
- 3 秒のポーリングには乗せない（見出しの盾を押したときだけ取る）。

## Jev

### 表示

- 確率は `Approval.jev`、画面は `web/src/JevTag.tsx`。色分けの区切り（0.8 / 0.3）は `jevLevel()` の 1 つだけ。
- 何を聞くか・何を送るかは `shared/jev.ts`:
  - `jevAsks()` = SAI が答えられる許可だけ。質問は聞かない。
  - `jevState()` = Claude はツール名と名指しの項目（コマンド・パス・URL・説明・理由）、Codex / OpenCode は名指しの項目から組んだ要約、Codex のダイアログの中身まで。input は丸ごと送らず項目を名指しする。ファイルの中身・メッセージの本文・cwd・Claude の要約（`approvalText()`）は送らない。
- 送るのは `server/approvals/jev.ts` の `JevRisk`:
  - `approvalsNow()` の最後で `annotate()` が写しに確率を付ける（承認の預かりの本物は触らない）。
  - 聞いていないものは投げるだけで答えを待たない。届いたら `approvalMapKey()` が確率も混ぜるので rev が変わる。
  - 同じ `approval_id` には 1 回だけ（失敗も覚えて聞き直さない）、同時に 2 本まで、見なくなってから 30 分で忘れる（見かけるたびに時刻を進める）。
- 聞く文は英語の 1 文（`JEV_SAFE_STATEMENT`）。

### 口の組み立て

- 環境から口を組むのは `server/main.ts`（`jevFromEnv()`）だけ。`createApp` の既定（`TerminalDeps.jev` を省略）は「送らない」。
- 入切は `settings.json` の `jev`（既定は入。自分のメニューの `JevControls`）。送り先は固定で `redirect: 'error'`。

### 自動で「常に許可」（#499）

- 閾値は `settings.json` の `jev_auto`（0 = しない が既定、それ以外は 0.5〜1）。判定は `shared/jev.ts` の `isJevAuto()` / `jevAutoAllows()`。画面は自分のメニューの `JevControls` の select。`jev` を切ると 0 に戻る。
- 動かすのは `jevAutoTick()`。呼ばれるのは 3 か所: 許可を預かった時（`POST /api/approvals`）・Jev の答えが届いた時（`JevRisk.onArrive`）・設定を変えた時。同時に 1 本（届くたびに呼ばれる）。
- 流れ: `approvals.snapshot()`（Claude の `-p` の許可だけ）を `annotate()` し、`jevAutoEligible()`（Bash だけ）で絞り、この回のコマンドとルールの両方が閾値以上のものだけを画面の [常に許可] と同じ答え（`permissionsFor()`）で `approvals.answer()` し、`reply.log` に残す。
- ルールは `JevRisk.ruleSafe()` が `JEV_RULE_STATEMENT`（`jevRuleState()`）で別に聞く（`Bash(rm:*)` のような前方一致は Jev が見た 1 回より広い）。`JEV_RULE_STATEMENT` は「普段の作業（調べる・ビルド・テスト）の範囲として許してよいか」を聞く文。
- つないだコマンドは `alwaysRules()` の**部品ごとに** `ruleSafe()` で聞き、`jevLowestRule()`（一番低いもの。1 つでも届いていなければ待つ）で判定する（#705）。`Approval.jev_rule` も一番低いルール。
- 答えるか・なぜ答えないかは `shared/jev.ts` の `jevAutoDecision()` の 1 つで決める（#553）。この回が閾値以上なのに答えないもの（Bash 以外・ルールの確率が閾値未満・ルールを作れない形のうち読むだけと分からないもの）は、理由を `reply.log` に同じ許可に 1 行だけ残す。
- **ルールを作れない Bash は、読むだけと分かっているコマンドなら今回だけ許可する**（#749。`jevAutoDecision()` の `once`）。この回の確率が閾値以上で、ルールが空だった理由が `covered` / `not_bash` でなく、`shared/bashReadOnly.ts` の `notReadOnly()` が空を返したときだけ。答えは画面の [許可] と同じ（`updatedPermissions` を付けない＝覚えない）で、ルールの確率は聞かない（書かれるルールが無い）。記録は `by: jev`・`remember: false`・`no_rule`・`jev`、画面には「答えた許可」（#693）として「Jev が自動で許可（N%）」が残る。ルールを作れる形は今までどおり [常に許可]（ルールの確率が低くても「今回だけ」には落とさない）
- **`notReadOnly()` は「知っているものだけ受ける」読み取り**（拒否の一覧ではない）。分からないものは全部、理由の種類（`NotReadOnly`: `syntax` / `command` / `flag` / `path` / `secret` / `opaque`）を返して人に回す:
  - 構文（`Reader`）: 受けるのは、語（素の字・`'…'`・`"…"`）、`&&` `||` `;` 改行 `|`、サブシェル `( … )`、コマンド置換 `$( … )`、空白のあとの `#` のコメント、捨てるだけのリダイレクト（`2>&1`・`>/dev/null` の類）。**それ以外の字に当たったらその場で `syntax`**（`$X`・`${…}`・`$'…'`・`$(( ))`・バッククォート・バックスラッシュ・`{` `}`・`<` `>`・ヒアドキュメント・`&`・`|&`・引用符の外の非 ASCII・`\r`）。二重引用符の中のバックスラッシュは英数字の前（`\n`）だけ受ける
  - コマンドの名前: 引用符も展開もグロブもパスも無い素の語で、`COMMANDS` にあるものだけ。**多機能なコマンドは入れない**: `printf`（`-v` が変数に書く）・`jq`（式が環境変数を出せる・終わらない）・`rg`（下へ潜る）・`cd`（`CDPATH`・別名）・`diff`（ディレクトリの中身を出す）・`sleep` / `seq`・`env` / `printenv`・シェル・インタプリタ・`xargs`・`awk`・`curl`・`tmux`・前に付く語（`command` / `env` / `exec` / `time`）
  - フラグ: コマンドごとに、値を取らないもの・次の語を値に取るもの・`--name=value` の形を 1 つずつ書く（`takeFlags()`）。知らないフラグは `flag`
  - **シェルが展開する語（引用符の外のグロブ・`~`・zsh の拡張グロブの `^`）は、どの引数でも受けない**（`lit()`。`grep -v .e*` はパターンのつもりの語が `.env` に展開されて読む先になる）。受けるのは名前を並べるだけの `ls` の引数と、git のリビジョンの `^` `~` だけ
  - 読む先（`readPath()`）: 中身の分かる語で、cwd の中で、`..` を含まず、**階層ごとに** `shared/files.ts` の `isSecretPath()` に当たらないもの（`secrets/db.yml`・`.envs/prod`）
  - 読む先の無い形（`cat`・`grep foo`・`wc -l`）は、パイプの 2 つ目以降だけ（`Check` の `piped`。先頭だと標準入力を待って止まる）
  - `git`: 読むサブコマンドだけ（`GIT_READS`・一覧する形だけの `GIT_LISTS`）。フラグは知っている長いフラグ（`GIT_LONG`）と、**値を取らない 1 字の短いフラグ**（`GIT_SHORT`）だけ。git は長いフラグの省略形を受け、まとめた短いフラグを 1 字ずつ読む（`git grep -GOrm` は `-O rm`）ので、拒否の一覧でも「フラグの形なら通す」でも止まらない。フラグでない語が外のパス・グロブ・秘密の名前なら断る。サブコマンドの前に受けるのは `--no-pager` だけ
  - `gh`: 形は `gh [-R owner/repo] <まとまり> <サブコマンド> …` だけ（`GH_READS` と、GET の `gh api <読む先>`）。フラグは `GH_BARE` / `GH_VALUE` を 1 語ずつ。知らないフラグを 1 つでも受けると、gh はその次の語を値として読み飛ばす（`gh pr --body view merge 5` が `pr merge` になる）。`--jq` / `--template` は入れない。値が `-` で始まるものは受けない
  - `$( … )` の結果（`Word.opaque`）を渡してよいのは `echo` だけで、二重引用符の中に書いたもの（`Word.loose` でない）だけ（bash は引用符の外の結果をグロブとして展開する）。コメントはいちばん外の並びでだけ受ける
  - git の語は、署名を確かめる書式（`%G?`・`%(signature)`。`gpg` を起こす）を含めば断る。`git diff` のフラグでない語は 1 つまで（リポジトリの外では `git diff a b` が `diff -r` になる）。`<リビジョン> -- <パス…>` の形は受ける。gh のフラグでない語は URL・`host/owner/repo` を受けない。読む先と git の語の字は ASCII だけ
  - `READ_ONLY_MAX_CHARS`（1000 字）より長いコマンドは通さない（`jevState()` がコマンドをその長さで切るので、Jev が全部を見ていない）
- **残っている限界**: セッションの cwd と実際の場所のずれ（人が前に許可した `cd`。判定は行の cwd で行う）・cwd の中のシンボリックリンク・`isSecretPath()` が見ない名前（`token`・`kubeconfig`・`.mcp.json`）・追跡されている秘密（`git log -p`）・git 自身の設定で走るもの（`diff.external`・`core.fsmonitor`）
- **テストと調査は、文字列を `notReadOnly()` に渡すだけ**（コマンドを実行しない）
- ルールの確率は `Approval.jev_rule` として許可のバブルにも出す。`approvalsNow()` は `JevRisk.peekRule()` で覚えているものを見るだけで、読む経路から外へは送らない。
- Codex / OpenCode の許可には「常に許可」が無いので触らない。
