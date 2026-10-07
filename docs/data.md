# データ

JSONL の1行に何が入るか、画面から付ける表示名・アイコン・アーカイブをどこに持つか。セットアップは [README](../README.md)。

## 受け口は JSONL 1本だけ

```
Claude Code ──[Stop hook]──┐
                           ├──> ~/.agent-feed/YYYY-MM-DD.jsonl ──> SAI
Codex CLI ──[notify]───────┘
```

フックがやるのは1行 append するだけ。集計も表示もしない。記録が壊れても表示が壊れるだけで済むし、表示を作り変えても記録側は触らずに済む。

### 複数のマシンで使うときはファイルを分ける（#113）

`AGENT_FEED_HOST` を設定すると、書き込み先が `YYYY-MM-DD.<host>.jsonl` になる（設定しなければ今までどおり `YYYY-MM-DD.jsonl`）。同期フォルダ（iCloud / Syncthing / rsync）で 1 つの置き場を共有すると、**複数のマシンが同じファイルに追記して片方が捨てられるか競合コピーができる**ため。

```
~/.agent-feed/
  2026-09-09.jsonl        ← AGENT_FEED_HOST 無しのマシン
  2026-09-09.mini.jsonl   ← AGENT_FEED_HOST=mini
  2026-09-09.air.jsonl    ← AGENT_FEED_HOST=air
```

- `<host>` は行の `host` と同じもの（`gethostname()` の短い形か `AGENT_FEED_HOST`）を、`[A-Za-z0-9_-]` 以外を `-` にして使う。`.` は `host` の時点で落ちているので、ファイル名が `日付.host.jsonl` として読めなくなることはない
- **サーバはその日の `YYYY-MM-DD.jsonl` と `YYYY-MM-DD.*.jsonl` を全部読む**（`server/rows/store.ts` の `feedFiles()`）。読む順は日付 → `host` 名（`host` 無しが先）で固定し、行は `ts` で並べ直す。`(mtime, size)` のキャッシュと `rev` はファイルごとなので、別のマシンのファイルが増えたり追記されたりすれば画面のポーリングが拾う
- **記録側は自分のファイルしか読まない**。合成セッション（`synth`）と待ちの重複判定は自分のマシンの続きを見るものなので、同期されてきたファイルは探索の対象外
- 同期の途中で末尾が切れた行は JSON として壊れているので `parseRows()` が落とす。次のポーリングで揃う

## 1行の形

```json
{
  "ts": "2026-09-02T12:45:04+09:00",
  "agent": "claude",
  "repo": "repo-a",
  "branch": "20260902",
  "session": "sess-abc",
  "session_source": "payload",
  "cwd": "/home/user/repo-a",
  "event": "Stop",
  "text": "背中のメニューを出した。ワンハンドロウ 10kg×10×3。",
  "user_text": "背中のメニューを出して",
  "thinking": "背中は前回ラットプルダウンだったので、今回はロウ系を中心にする",
  "model": "claude-fable-5-1",
  "first_user_text": "背中のメニューを出して"
}
```

| フィールド | |
| --- | --- |
| `remote` | origin の URL を `https://host/owner/repo` に正規化したもの（`record.py` の `normalize_remote()`。ssh の `git@host:o/r.git` も同じ形、認証情報と `.git` は落とす）。origin が無ければ空。画面が一言の中の `#123` をこのリポジトリの issue に向けるのに使う |
| `v` | 記録側の版（`record.py` の `RECORD_VERSION`。`shared/types.ts` にも同じ値があり、ずれると `pnpm test:feed` が止まる）。行の形を変えるたびに上げる。無い行は試作か古い `record.py` が書いたもの（1 扱い） |
| `agent` | `claude` / `codex` / `opencode` / `grok` / `unknown`。payload の形で当てるが、`record.py --agent <名前>` と名乗られていればそれ（OpenCode のプラグインはこちら）。Grok Build は Claude 向けの別名（`hook_event_name` / `session_id`）も載せてくるので、camelCase の `hookEventName` があれば Claude より先に `grok` にする（#325） |
| `repo` | `git rev-parse --show-toplevel` の basename。bare + worktree の構成では worktree のディレクトリ名（`dev-worktree-c` など）になり、GitHub のリポジトリ名とは限らない。画面では「worktree」と呼ぶ（同じリポジトリに複数あるときだけ絞り込みに出る）。エンティティID（`<セッション>@<リポジトリ>`）はこれで作るので、値は変えない |
| `project` | **どのリポジトリのものか**（`Naturalclar/sai`）。`remote` があればその `owner/repo`、無ければ `git rev-parse --git-common-dir` から取ったリポジトリ名だけ（bare なら `…/sai.git` → `sai`、普通の clone なら `<toplevel>/.git` → その親、のどちらでも同じ答えになる）。画面の絞り込みと見出しはこれを使う。無い行（古い `record.py`）はサーバが `remote` から補い、それも無ければ **`cwd` で git を読んで埋める**（`server/git/project.ts`。cwd ごとに 1 回だけ）。**それでも分からなければ空**で、絞り込みの候補には出さない（`repo` = worktree 名には落とさない。#182） |
| `session_source` | `payload`（ペイロードから）/ `rollout`（Codex のファイルから）/ `synth`（時間で合成）。一覧の信頼度がここで分かる。セッションとしては、合成の行が 1 本でもあれば `synth`、そうでなければ**値のある一番新しい行のもの**（`server/rows/aggregate.ts` の `latestValue()`。`branch` / `host` / `remote` / `project` / `agent` も同じ取り方）。**値の無い行では上書きしない**ので、試作や古い `record.py` の行（キーごと無い）が途中に混ざっても、そのセッションが「IDの出どころが不明」になって返信を弾かれることはない（#283。前は「最後に初めて出てきた値」を使っていて、`payload` → 空 → `payload` で空になっていた） |
| `event` | 何の行か。ターン完了は `Stop`（Claude / Grok）/ `agent-turn-complete`（Codex）/ `session.idle`（OpenCode）。人を待って止まった行は `PermissionRequest` / `PreToolUse` / `Notification` / `permission.asked`（OpenCode）、人が答えて再開した行は `UserPromptSubmit` / `permission.replied`（OpenCode）、セッションが終わった行は `SessionEnd`（Claude だけ。#385。`text` は `セッション終了: 会話をリセット（/clear）` のように**なぜ終わったか**）。読み方は `shared/events.ts` の `eventKind()` にまとめてあり、集計と画面が同じ判定を使う。**ここに挙がっていない値（`SubagentStop`、Codex の `session-configured` など）は `other` で、ターンにも数えず画面にも出さない**（#235）。`hook_event_name` も `type` も無いペイロードでは `unknown` になり、これはターン完了として扱う |
| `text` | ターン完了なら最後のアシスタント発話。Claude は `transcript_path` の**そのターンぶん**から（#467。末尾から遡るが**人の入力の行で止まる**ので前のターンには落ちない。返すのはそのターンの**いちばん新しい**本文で、それが閉じた行（`end_turn` / `stop_sequence`）でなければ、**`Stop` フックはその行が書かれる前に走る**ので最大 2 秒待つ。それでも現れなければターン途中の地の文か空で、前のターンの返答は載せない。待つのは `Stop` のときだけ）、Codex は `last-assistant-message`、Grok は `lastAssistantMessage`（無ければ `chat_history.jsonl` の最後の assistant）。20,000文字で切る（#358。前は 2,000 文字で、返答の 4% が読めないところで切れていた）。待ちの行なら「何を待っているか」（300文字）、再開の行は空、終了の行は「なぜ終わったか」 |
| `user_text` | そのターンの入力（人が打った文）。Claude の `UserPromptSubmit` の行はペイロードの `prompt` そのもの。`Stop` の行は `transcript_path` を末尾から遡って最後の入力（ツールの戻りや差し込み、自動の要約の行 `isCompactSummary` は飛ばす。スラッシュコマンドは `/foo 引数` に戻す。バックグラウンドのタスク完了の通知 `<task-notification>`（`promptSource: system`）で始まったターンは人の入力が無いので空）、Codex は `input-messages` の末尾（resume/queue 後は過去の入力も含まれるため）。画面2で自分側のバブルになり、一番新しい行のものが一覧のタイトルになる。20,000文字で切る |
| `thinking` | そのターンの思考。Claude は `transcript_path` の最後のターン（最後の入力より後）の `thinking` ブロックの本文を `\n\n` で繋いだもの（`signature` だけのブロックは飛ばす）、Codex は rollout の最後のターンの `reasoning` の `summary[].text`。**無いことが多い**（[design-notes.md](design-notes.md) の 4）。ターン完了の行だけ。20,000文字で切る（先頭側を残す）。画面2のエージェントのバブルに折りたたんで出す。`GET /api/feed` の行からは落とす |
| `model` | そのターンを回したモデル。Claude は `transcript_path` の最後の assistant 行の `message.model`（`claude-fable-5-1` など。CLI が合成した `<synthetic>` は飛ばす）、Codex は rollout の最後の `turn_context.model`（`gpt-5.6-sol` など）。ターン完了の行だけ。画面2の見出しに出す |
| `host` | どのマシンで記録したか（#112）。`AGENT_FEED_HOST` があればそれ、無ければ `gethostname()` の短い形（`mbp.local` → `mbp`）。**複数のマシンの JSONL を 1 か所に集めたとき**（[#24](https://github.com/Naturalclar/sai/issues/24)）に行の出どころを分けるためのもので、1 台で使う分には見えない。合成セッション（`synth`）のまとめ方もこれで割るので、別のマシンの同じ `repo` / `cwd` の行が 30 分以内に来ても同じセッションにはならない |
| `pane` / `pid` | セッションが開いている tmux のペイン（`%12`。フックが受け取る `TMUX_PANE`）と本体の pid（Claude は `CLAUDE_PID`、Codex は notify の親から辿った `codex` 本体。ラッパー越しの notify でも本体に届く。見つからなければ親。#332。TUI が共有の `codex app-server --listen` の客のときは、ターンを回した app-server の pid になり、`pane` はその app-server を起こしたペイン（その app-server が回すどの会話の行も同じペインになる）。#562）。SAI の返信をそのペインに打ち込むのに使う。tmux の外なら `pane` は空。**SAI が起動したターン（`claude -p` など）でも空**（サーバが子に `TMUX_PANE` を渡さない。#234）|
| `permission_mode` | そのターンの許可モード（Claude のフックの `permission_mode`。`default` / `acceptEdits` / `plan` / `auto` / `dontAsk` / `bypassPermissions`）。Codex には無い。一番新しい行の値が一覧とチャット見出しの印になる |
| `first_user_text` | 最初のユーザー発話。`user_text` が1行も無い古いセッションのタイトルに使う。300文字で切る |
| `clipped` | 本文を上限で切った項目（`["text"]` / `["user_text", "thinking"]` など。#358。質問の形を切ったときは `"questions"`）。切っていなければ**キーごと無い**。画面はその本文の末尾に「ここで切れています」を出す（切ったことが分からないと、そこで終わったのか切られたのかが読めない）。`first_user_text` は本文ではないので数えない |
| `questions` | `AskUserQuestion` の待ちの行（`PreToolUse` / `PermissionRequest`）だけに載る、質問と選択肢（#334。v9 から）。`[{ question, header, multiSelect, options: [{ label, description }] }]` で、キーの名前はフックの `tool_input.questions` と同じ。`text` は今までどおり質問の文だけ（`質問: A / B`）なので、選択肢はここから出す。問は 8・選択肢は 10・文は 500 字（見出し 100・選択肢の名前 200）で切り、切ったら `clipped` に `"questions"`。読めない質問しか無ければ**キーごと無い**。画面は待ちのバブルの下に読むだけで出し（セッション画面・フィード）、無い古い行は #333 の transcript から読む方に落ちる |

日付は `Asia/Tokyo` で切る。

Codex TUI の質問・許可待ちは `notify` から取れないため、JSONL の行にはしない。サーバの `CodexDialogs` が tmux ペインを確認し、ダイアログ中だけ API の `approvals` に `agent: codex`, `answerable: false` の検出専用項目を足す。ペイン、pid、ダイアログのいずれかが確認できなくなれば消える一時状態で、履歴には残らない。

SAIから開始したCodex turnの待機もJSONLにはせず、`CodexAppServer` のメモリに持つ。`Approval.decisions` は画面用の不透明なid・ラベル・allow/deny表示だけで、app-serverへ返すdecision本体とJSON-RPC request idはブラウザへ出さない。回答、`serverRequest/resolved`、turn完了、切断のいずれかで消える。

`first_user_text` は1行目だけでなく**毎行**に載せている。集計は「一番古い行の値」を使うので結果は同じで、`days` で切った窓の外にセッションの1行目が落ちてもタイトルが消えない。

## セッションの表示名とアイコン

一覧の名前は入力（`user_text` / `first_user_text`）から自動で作るが、ブラウザから自分で付けた表示名と、手元の画像ファイルのアイコンで上書きできる（チャット見出しのアイコンボタン。鉛筆が「名前を付ける / 名前を変える」、写真が「画像を選ぶ / 画像を変える」、ゴミ箱が「画像を消す」。文字は出さないが、ホバーと読み上げでは同じ文言が出る。名前を消すのは入力欄を空にして保存）。付けると、一覧とチャット見出しのほかに、**チャットのエージェント側のバブルの発言者名とアバター**もそれになる（無ければ「Claude Code」/「Codex CLI」と頭文字）。フィードでも同じで、サイドバーの一覧に載っているセッションの分は反映される（一覧の日数の窓に無いセッションは固定の名前に落ちる）。自分側の「あなた」は変わらない。

**表示名は Claude の CLI にも渡る**（#391）。SAI から返信すると `claude -n <表示名>` で起動するので、端末のタイトルと `/resume` のピッカーにも同じ名前が出る。名前はそのセッションに残るので、SAI で付け替えれば次の返信から端末側も変わる。**付けていないセッションには渡さない**（端末で付けた名前を空で上書きしない）。Codex / OpenCode には同じ口が無い。

表示名は JSONL ではなく `~/.agent-feed/session-meta.json` に持つ。

```json
{ "sess-abc@repo-a": { "name": "背中メニュー", "persona": "ISTJ", "digest_off": true } }
```

キーはエンティティID（`<セッション>@<リポジトリ>`）。記録側（`record.py`）はこのファイルを知らないし、集計（`aggregate()`）も触らない。サーバが応答を返すときに載せるだけなので、消しても履歴は壊れない。

`digest_off` は「このセッションでは一言（digest）を作らない」（#263）。**あることが状態**で、`archived_at` と同じ形（`PUT` に `false` / `null` / 空 を送れば消えて、また作るようになる）。`boolean` にすると `mergeMeta()` の「falsy なら消す」に当たって `false` が保存できないので、この形にしてある。

写真のボタン（「画像を選ぶ」）でファイルを選ぶと**加工のモーダル**が開き、正方形の枠に対してドラッグで位置、ホイールかスライダで大きさを決めて「これにする」を押すと、**256px 四方・角丸（一辺の 20%）の PNG** にしてから置く。元のファイルは送らない（ブラウザの Canvas で加工する。サーバ側に画像処理は無い）。選べるファイルは 20MB まで（`ICON_SOURCE_MAX_BYTES`）、置く加工後の PNG は 1MB まで（`ICON_MAX_BYTES`）。GIF はアニメーションが止まる（1 フレーム目）。画面の角丸 CSS も同じ 20% なので、加工前に置いた古い画像も同じ見た目で出る。

アイコン画像は `~/.agent-feed/session-icons/<sha1(ID) の先頭16桁>.<png|jpeg|gif|webp>` にファイルで置く（`session-meta.json` には書かない。ファイルの有無が正）。PNG / JPEG / GIF / WebP で 1MB まで（画面から置くものは加工後の PNG。API を直接叩けば他の種類も置ける）。種類はファイルの中身（先頭のバイト列）で見るので、拡張子だけ画像のファイルは置けない（SVG も受けない）。一覧の各セッションには `icon`（`/api/sessions/<id>/icon?v=<mtime>`）として URL が載り、差し替えると `v` が変わってブラウザのキャッシュを引かない。画像を置いた・消しただけでも一覧の `rev` が変わるので、開いている画面にそのまま反映される。昔の絵文字のアイコン（`icon` キー）は読むときに捨てる。

## 自分の表示名とアイコン

チャットの自分側のバブルは既定では「あなた」（名前）と「私」（アバター）。**ヘッダー右端の自分のアイコン**を押すとメニューが開き、「表示名とアイコン」で名前と画像を付けられる。付けると、過去の行も送信中の仮バブルも、その名前とアバターになる。SAI は1人のローカルの道具なのでプロフィールは1つ。

表示名は `~/.agent-feed/profile.json`（`{ "name": "Jesse" }`）、アイコンはセッションのアイコンと同じ `~/.agent-feed/session-icons/` に固定の鍵 `me` で置く（エンティティ ID には必ず `@` が入るので衝突しない）。画像の加工（正方形・角丸の PNG）もセッションのアイコンと同じモーダルを通す。記録側（`record.py`）も集計も触らず、サーバが応答の `profile` に載せるだけ。名前や画像を変えると `rev` が変わるので、開いている別のタブにもポーリングで反映される。

## 未読の印（#502）

どこまで読んだかは `~/.agent-feed/read-marks.json` に持つ（JSONL は触らない）。セッションごとに**読んだ最後の返答の時刻（ミリ秒）を 1 つだけ**。`since` は初めてファイルを作った時刻で、**印の無いセッションはそこまで読んだ扱い**にする。

```json
{ "since": 1790658563592, "sessions": { "sess-abc@repo-a": 1790744911000 } }
```

未読の数はサーバが応答のたびに、窓の中の返答（ターン完了の行）のうち印より新しいものを数えて `SessionSummary.unread` に載せる。覚えるセッションは 2000 件まで（古い印から捨てる。捨てたものは `since` まで読んだ扱いに戻る）。

## Manager の案（#565）

`/manager` が `sai_suggest` で置いた案は `~/.agent-feed/suggestions.json` に、宛先のエンティティ ID ごとに 1 つだけ持つ（JSONL は触らない。置き直すと上書き）。

```json
{ "sess-abc@repo-a": { "text": "CI を見て、落ちていたら直して", "from": "このマシン", "at": 1790744911000, "busy": false } }
```

`from` は置いた呼び出し元（`このマシン` か tailnet のログイン名）、`at` は置いた時刻（ミリ秒）、`busy` は置いたときに宛先のターンが回っていたか（回っていたターンの終わりは人の入力と数えない）。画面に出すのは**置いてから 24 時間以内で、そのあと人の入力が来ていないもの**だけで、サーバが応答のたびに決めて `SessionSummary.manager_draft` に載せる。捨てる・入れると取り除く。24 時間を過ぎたものは次に置いたときにファイルからも捨てる（500 件まで）。

## アーカイブ

終わったセッションは**アーカイブ**して一覧とフィードから隠せる（Slack のチャンネルのアーカイブと同じで、消すのではなく既定では見えなくする）。これも同じ `session-meta.json` に `archived_at`（アーカイブした時刻、ISO）として持つ。

引き継いで始めたセッション（#442）は、同じファイルに前後を持つ: 新しい方に `continued_from`（前のセッションの ID）、前の方に `continued_to`（続きの ID）と `continued_at`（使った引き継ぎの行の `ts`。同じ引き継ぎで 2 回始めないための印）。

分岐して作った Codex のセッション（#405）は、分岐先に `forked_from`（元のセッションの ID）を持つ。元のセッションの側には何も書かない。

```json
{ "sess-abc@repo-a": { "name": "背中メニュー", "archived_at": "2026-09-02T07:40:00.000Z" } }
```

「アーカイブ済みか」は `archived: true` のような印ではなく、サーバが応答時に **`archived_at >= そのセッションの最後の行の ts`** で決める。アーカイブしたあとに端末でそのセッションを続けると最後の行が `archived_at` を追い越すので、メタを書き換えずに自動で一覧に戻る。「戻す」は `archived_at` を消すだけ。`synth`（時間で合成した ID）のセッションもアーカイブできる（#248。合成 ID は `record.py` が記録時に決めて行に書き込むので、集計の窓でずれない）。返信できないのは別の話（`replyBlockedReason()` の `synth`）。

## 派生のファイル（#703）

`~/.agent-feed/` には、記録（`YYYY-MM-DD.jsonl`）のほかに SAI が自分で書くファイルがある。どれも**派生**で、消しても記録は壊れない（消えるのはその機能の状態だけ）。上の節にあるもの（`session-meta.json`・`profile.json`・`read-marks.json`・`suggestions.json`・`session-icons/`）は省く。調べるときは使い捨てのスクリプトを書く前に `pnpm feed`（[使い方](internals/tooling.md#記録を調べるpnpm-feed703)）を見る。

鍵の「エンティティ ID」は `<セッション>@<リポジトリ>`、「行の鍵」は `<エンティティ ID>|<行の ts>`。

| ファイル | 形 | 何が入っているか |
| --- | --- | --- |
| `turn-usage.jsonl` | 追記。1 行 = SAI から回した 1 ターン | `ts`（CLI が終わった時刻。UTC）・`id`（エンティティ ID）・`model`・`input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`・`duration_ms`・`num_turns`・`denials`・`is_error`・`cost_usd`・`compact`（要約だけのターンに `true`） |
| `agent-messages.json` | 1 つの JSON | `messages`: 送った記録の配列（`message_id`・`from`・`to`（どちらもエンティティ ID）・`text`（見出しを付ける前の本文）・`since`（送った時刻）・`handed_at`（返答を送り元に渡した時刻）・`wake`・`turn`・`url`）。古いものから 500 件まで。`sends`: 送り元 → そのターンで送った回数（`turn`・`count`・`read`）。`origins`: メッセージで回っているセッション → その `message_id`。`stopped`: 人が送信を止めた送り元。`followups`: 返答のバブルの下から人が送った返信（#700。`id`・`from`・`to`・`text`・`at`・`anchor`。メッセージではないので `messages` には入らない） |
| `digest.jsonl` | 追記。1 行 = 1 つの一言 | `key`（行の鍵）・`persona`・`summary`（空なら作っていない）・`what` / `next`（#713。`summary` を 2 つで組んだ回だけ: 何が起きたか／人が次にすること。無ければ `summary` が 1 つの一言）・`model`・`ts`（作った時刻）・`next_ask`（次に送る文面の案）・`next_ask_source`（`quote` = 本文の引用をそのまま採った。無ければ口で作った）・`retried`・`issues`・`skipped`（わざと作らなかった理由）・`judge`（手元のモデルの判定） |
| `digest-feedback.jsonl` | 追記。1 行 = 1 つの合図 | `key`（行の鍵）・`summary`（そのとき出ていた一言）・`model`・`persona`・`reason`（「変？」の理由か、`opened` = 詳細を開いた・`next_ask_accepted` = 案を受け取った）・`next_ask`・`note`・`ts` |
| `approvals.jsonl` | 追記。1 行 = 許可に答えた 1 回 | `ts`・`id`（エンティティ ID）・`cwd`・`tool`・`rule`（「常に許可」のルールの表記）・`by`（`human` / `jev`）・`behavior`（`allow` / `deny`）・`remember`・`waited_s`・`no_rule`（#724。**`rule` が空の行にだけ**載る、空だった理由の種類。Bash の形は頭から読んで**最初に当たった 1 つ**: `expansion` / `redirect` / `heredoc` / `here_string` / `background` / `subshell` / `brace` / `comment` / `unclosed` / `keyword` / `assign_only` / `odd_command` / `env_value` / `cd_form` / `cd_no_cwd` / `cd_outside` / `cd_then_write` / `empty`（意味は `shared/bashRules.ts` の `BashNoRuleReason`）。ほかに `cd_only` / `covered`（組めたが全部もう設定にある。**設定は `cwd` の下だけ読むので、git の根より深い `cwd` では少なく出る**）/ `not_bash`（Bash でも MCP でもないツール）。#724 より前の行には無い）。コマンドの全文・引数・パスは書かない |
| `approvals.json` | 配列 | いま預かっている許可・質問（`approval` と、まだ渡していない `answer`）。サーバの立て直しをまたぐためのもの |
| `replying.json` | エンティティ ID → 1 件 | SAI が回している最中の返信: `pid`・`since`（起動した時刻）・`text`（送った文）・`permission_mode`・`compact`。**終わると消える**（履歴ではない） |
| `reply-queue.json` | エンティティ ID → `items` | 処理中に預かった返信: `queue_id`・`text`・`since`・`attachments`・`url`・`origin`。`paused` は自動で回さない理由 |
| `loops.json` | エンティティ ID → 1 件 | 組んだループの状態（`goal`・`until`・`max_rounds`・`round`・`status` など。`shared/loops.ts` の `LoopState`） |
| `reply.log` | 追記の文字のログ | SAI が起こした子の stdout / stderr と、SAI が足す 1 行（`--- <時刻> <エンティティ ID> <何をしたか>`） |
| `digest.log` | 追記の文字のログ | 一言を作る子の出力と、諦めた・作り直した理由 |
| `usage-claude.json` | 1 つの JSON | `statusline.py` が書く Claude の使用率（`v`・`ts`・`host`・`session`・`model`・`rate_limits`） |
| `usage-claude-replies.json`（`AGENT_FEED_HOST` があれば `usage-claude-replies.<host>.json`） | 1 つの JSON | SAI から回した Claude の返信の出力（`rate_limit_event`）から拾った使用率（#694。`v`・`ts` = 届いた時刻・`source`・`rate_limits`。形は `usage-claude.json` と同じ） |
| `mcp-sends.json` / `opencode-serve.json` / `icon-history.json` / `agent-token` | — | tailnet の MCP から送った時刻・SAI が起こした `opencode serve` の居場所・アイコンの履歴・エージェント用の口のトークン（**中身を出力に写さない**） |
| `attachments/` / `thumbs/` / `icon-history/` | ディレクトリ | 返信に添えたファイル・画像の軽い版・アイコンの履歴の画像 |

### 間違えやすい所

- **`turn-usage.jsonl` の `cost_usd` はそのセッションの積み上げ**で、1 ターンぶんではない（2026-09-19 05:00Z より前の行だけは 1 ターンぶん）。そのまま足すと何倍にもなる（#579 / #602 で実際に約 20 倍にした）。1 ターンぶんは同じ `id` の前の行との差で、`shared/turnUsage.ts` の `turnCosts()` が出す。**差を取ってから日付で絞る**（絞ってから差を取ると、範囲の最初の行にそれまでの積み上げが乗る）。トークン（`*_tokens`）は 1 ターンぶんなので差にしない
- **`turn-usage.jsonl` にあるのは SAI から回したターンだけ**（端末で打ったターンは無い）。全体の使用率は `usage-claude.json` と画面の `#/usage`
- **`user_text` が人の入力とは限らない。** 自動の要約が入ったターンの行は要約の文（`This session is being continued from a previous conversation…`）に置き換わっていて（#626 より前に書かれた行）、別のセッションから届いたメッセージは `【SAI】` で始まり、待たなかった返答は `【SAI 返答】` の塊として頭に足されている。人の入力を数えるときは `server/tools/feedRead.ts` の `humanPrompt()` を通す（#609 で要約を「長い入力」に数えた）
- **`user_text` は 2026-09-13（#360）より前の行では 2,000 字で切れている**（いまは 20,000 字。切ったら行に `clipped` が付く）
- **ターン完了は `event` の名前でなく `eventKind(event, text) === 'turn'` で見る**（`Stop` / `agent-turn-complete` / `session.idle`。`Notification` は本文で `waiting` と `idle` に分かれる）
- **エンティティ ID は自分で組み立てず `entityId()` を通す**（セッションが空の行は `unknown-<日付>`）。日付は `Asia/Tokyo` で切る（行の `ts` は `+09:00` 付き、`turn-usage.jsonl` と `agent-messages.json` は UTC の `Z`。文字列で比べない）
- **`reply.log` には stream-json が混ざる**（入力の口を開けた `claude -p` の stdout。1 行が数万字になる）。並行する返信の出力も混ざるので、`--- ` で始まる SAI の行だけを拾うか、`session_id` まで見る。大きい（100 MB を超える）ので丸ごと読まない
- **`replying.json` は「いま」だけ**。過去に何を送ったかは記録の `UserPromptSubmit` の行か `reply.log` の `--- ` の行で見る
- 記録のファイルは `YYYY-MM-DD.jsonl` のほかに `YYYY-MM-DD.<host>.jsonl` がある（#113）。日付から名前を組み立てると別のマシンのぶんが落ちる
- 置き場の `*.jsonl` のうち、名前が日付で始まるものだけが記録（`turn-usage.jsonl` などを行として読まない）

## 履歴はリポジトリに入れない

`~/.agent-feed/` はリポジトリの外。作業内容の断片が入るので、うっかりコミットされない場所に置く。`.gitignore` の `*.jsonl` / `.agent-feed/` / `sessions/` は、手元にコピーしたときの保険として最初のコミットから入っている。
