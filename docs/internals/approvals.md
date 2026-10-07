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
- `bashRulePrefixes(command, cwd)`: `&&` / `||` / `;` / 改行 / `|` で部品に分け、部品ごとに「環境変数の代入 + 先頭 1 語（`SUBCOMMAND_CLIS` は 2 語）」を返す。`cd` と `UNASKED`（読むだけのコマンド）には作らない（ほかに書くルールが 1 つも無いときは `UNASKED` の部品に作る。引数しだいで聞かれるので）。null にするのは、切れない・通らない形（展開・波括弧・サブシェル・`KEYWORDS`・ファイルへのリダイレクト・`&`・行の途中の `#`・閉じていない引用符）、`cd` の行き先が `cwd` の外か `cwd` が分からないとき、`cd` と `NOT_AFTER_CD`（書き込み系と `git`）をつないだとき。`"$(cat <<'EOF' … EOF)"` は中身ごと空の引用符に置き換えてから読む。
- もう設定にあるルールは `terminal.allowedRules`（`permissions.ts` の `allowRules()`。設定ファイルを読むだけ）から。**本物を読むのは `main.ts` だけ**で、`createApp` の既定は「読まない」（テストが回したマシンの設定で変わらないように）。
- 画面は `ApprovalBubble` が `approval.always` を `AlwaysRules` で並べる。**画面はルールを組まないし送らない**。
- 入口は 2 つ: 人が押す [常に許可] と、Jev の自動の「常に許可」（#499。下の「自動で常に許可」）。

### 許可した回数と「常に許可」の勧め（#445）

- 記録は `server/approvals/approvalLog.ts` の `ApprovalLog`（`<feed dir>/approvals.jsonl`）。`answerApproval()` が Claude の許可に答えたときと、Jev の自動の「常に許可」（`jevAutoOnce()`）のあとに `logAnswer()` が 1 行足す（`ApprovalLogRow`: `ts` / `id` / `cwd` / `tool` / `rule` / `by` / `behavior` / `remember` / `waited_s`）。cwd はセッションの行から取り、コマンドの全文は書かない。Codex・OpenCode・端末のダイアログの答えは足さない。
- **`rule` が空の行には、空だった理由の種類 `no_rule` を添える**（#724。`NoRuleReason`）。Bash の形は `shared/bashRules.ts` の `bashRulePlan()` が返す（`bashRulePrefixes()` はこれを呼んで `null` に畳むだけなので、[常に許可] を出すかの判定と記録の理由は同じ 1 つ）。`cd` しか無い（`cd_only`）と Bash でないツール（`not_bash`）は `alwaysAllowPlan()`、組めたが全部もう設定にある（`covered`）と Claude の許可でない（`not_claude`）は `app.ts` の `alwaysPlan()` が付ける。**種類だけ**で、コマンドの文字・引数・パスは持たない。
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
- 答えるか・なぜ答えないかは `shared/jev.ts` の `jevAutoDecision()` の 1 つで決める（#553）。この回が閾値以上なのに答えないもの（Bash 以外・ルールを作れない・ルールの確率が閾値未満）は、理由を `reply.log` に同じ許可に 1 行だけ残す。
- ルールの確率は `Approval.jev_rule` として許可のバブルにも出す。`approvalsNow()` は `JevRisk.peekRule()` で覚えているものを見るだけで、読む経路から外へは送らない。
- Codex / OpenCode の許可には「常に許可」が無いので触らない。
