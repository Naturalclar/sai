# server の仕組み

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/server.md](../history/server.md)。

## 骨組み（main.ts / createApp）

- `server/` は node:http 直書きで依存ゼロ。
- `main.ts` は引数処理と bind 先チェックだけ。ルーティングは `createApp(store, distDir)` にあり、テストはこれを直接叩く。

## 終わり方（shutdown）

C-c / SIGTERM では必ず終わる（#296。`main.ts` の `shutdown()`）。

- `server.close()` は listen を先に落とすが、コールバックは接続が全部閉じてから呼ばれる。そこで `closeIdleConnections()` を続けて呼び、残るものは `CLOSE_ALL_MS`（1 秒）で `closeAllConnections()`、それでも抜けなければ `FORCE_EXIT_MS`（3 秒）で諦めて終わる（タイマーは `unref()`）。
- 2 回目の C-c はすぐ終わる。
- 抜けられないのは「リクエストを最後まで送っていない接続」（ブラウザの先読み・送信途中）。ポーリングする keep-alive もアイドルの keep-alive も `close()` が自分で切る。
- 返信の子は別の pgid で detached なので巻き込まない（次のサーバが `replying.json` から引き取る）。
- `createApp()` の戻りの `dispose()` を、`shutdown()` の `onStop` が 1 回目の C-c の頭で 1 度だけ呼ぶ。接続が閉じるのを待つ前なので、`FORCE_EXIT_MS` で諦める筋でも通る。

### SAI が起こした `opencode serve` の扱い

- ターンを回していなければ落とす（#457）。
- 回しているときは落とさずに次のサーバへ渡す（#440）。`opencode-serve.json` に pid・待ち受け先・鍵・回しているターンを書き（立った時点で書くので、SAI が落ちても引き取れる）、次の `OpencodeServer` が pid が生きていれば引き取ってターンを処理中として戻す。待ち受け先はそのファイルから読む。
- serve は別の pgid で起こし（C-c の SIGINT を受けない）、出力は `opencode-serve.log` に書かせる。
- `codex app-server --stdio` は stdin で繋いでいるので引き取れない。親が死ぬと stdin のパイプが閉じて自分で終わるので、`dispose()` でも触らない。

## 行の読み込み（store.ts）

- 日付ファイルを `(mtime, size)` で覚えて、変わらなければ再パースしない。そのシグネチャのハッシュを `rev` として返す。
- 読む先は日付から組み立てず、`readdir` して `feedFiles()` で拾う（#113）。`YYYY-MM-DD.jsonl` に加えて、マシンごとに分けた `YYYY-MM-DD.<host>.jsonl` も全部読む。並びは日付 → `host` 名で固定し、行は `ts` で並べ直す。

## 本文の検索（rows/search.ts）

- `server/rows/search.ts` の `searchRows()`（#230。`GET /api/search?q=&days=90`）。
- 索引は持たず、`store.rows()` が持っているパース済みの行を舐めるだけ。
- 新しい順に `SEARCH_LIMIT`（100）まで。
- 当たりの判定と抜粋は `shared/search.ts` を画面と共用する。

## 使用量（local/usage.ts）

`GET /api/usage` は `server/local/usage.ts` の `UsageStore` がローカルのファイルを読むだけ（#216 / #250）。

### Claude

- 割合（`feed/statusline.py` が書く `<feed dir>/usage-claude[.<host>].json`）と「いま上限に当たっているか」（`~/.claude/projects/*/*.jsonl` の `quotaLimits`）を `mergeClaudeUsage()` で重ねる。片方だけのことがあるので、`ClaudeUsage.primary` / `limited` はそれぞれ任意。
- ステータスラインの割合は、枠の `resets_at` を過ぎたものと、`STATUS_MAX_AGE_MS`（8 日）より古いファイルを捨てる。
- 書く側（`feed/statusline.py`）も同じ条件で、`resets_at` を過ぎた窓は書かない（`live_windows()`。全部過ぎていればファイルに触らない）。置いてある記録のほうが新しければ上書きしない（`windows_to_write()`。`ts` が今より先で、`NEWER_TRUST_SECONDS`（5 分）以内で、生きている窓が 1 つはあるときだけ。読めない `ts`・先すぎる `ts`・窓が全部戻った記録は上書きする）。期限切れの境界（`resets_at <= now`）は `feed/test_statusline.py` と `shared/usage.test.ts` に同じ形で置く（#683）。
- 書く窓は `windows_to_write()` が置いてある記録と突き合わせて決める（#689）。`merge_windows()` は窓ごとに新しいほうを残す: `resets_at` の差が `SAME_WINDOW_SECONDS`（60 秒）以内なら同じ窓で割合の高いほう、先へ進んでいれば新しい窓で来たほう、手前なら置いてあるほう。来なかった窓は持ち越す（`resets_at` の無い窓は持ち越さない）。**置いてあるものと同じになったら書かない**ので、`ts` は割合が最後に変わった時刻になる。窓ごとに `changed_at`（その窓の割合が最後に変わった時刻。読む側は見ない。無ければ記録の `ts`）を持ち、`KEEP_SECONDS`（24 時間）より長く変わっていない窓は、同じ窓の低い値でも置き直す。
- `AGENT_FEED_DEBUG=1` のときだけ、`statusline.py` は描画 1 回につき 1 行の JSON を `<feed dir>/statusline-debug.log` に足す（#694。`write_debug()` / `debug_entry()`）。残すのは `ts`・`session`・`version`・`model`・`api_ms`（`cost.total_api_duration_ms`）・`skip`（`AGENT_FEED_SKIP` が付いていたか）・`keys`（入力の一番上のキーの名前）・`has_rate_limits`・`rate_limits`（来たままの形。`windows_of()` が捨てる窓も見えるように絞らない）。本文・パスは残さず、文字列は `DEBUG_MAX_STRING`（40 字）で切り、配列は長さだけにする。`DEBUG_MAX_BYTES`（5 MB）を超えたら足さない。`AGENT_FEED_SKIP=1` の描画や読めない入力も 1 行にする（割合を出すのに要る）。拡張子を `.jsonl` にしないのは、feed dir の `*.jsonl` が記録として読まれるため。書けなくても表示と `usage-claude.json` は巻き込まない。

### Codex

- rollout は `tailLines()` で末尾 64KB だけ読む。
- 候補は mtime の新しい順に数件。開きっぱなしのセッションは古い日付のディレクトリに追記され続けるので、日付の新しさで打ち切らない。
- **復帰時刻を過ぎた枠は、画面が割合を出さない**（#726）。サーバは rollout の値をそのまま返し、判定は `shared/usage.ts` の `windowExpired()`。チップは `usageChips()` が `waiting` を立てて「更新待ち」と出し（色にも数えない）、パネルの `UsageBar` はゲージの代わりに「更新待ち」と、下の行に「10/5 15:38 に戻った・次に使うと更新」を出す。0% とは出さない（別の端末で使い切っていると嘘になる）。説明の文は `waitingNote()` の 1 つ（ゲージとチップの title が同じ文）。5 時間の枠が過ぎていても、週の枠が生きていて `USAGE_WARN` 以上なら、チップは週の割合を出す（`CodexFreshness.week`）。Claude の枠も `usageChips()` と `UsageBar` が同じ判定を通す（サーバは過ぎた枠を落とすが、30 秒のキャッシュのあいだに過ぎることがある）。
- 値を拾ってから `USAGE_STALE_MS`（30 分。Claude と同じ）を過ぎたら「古い」の印を付ける（`codexFreshness()`。#726）。チップでは、復帰時刻を過ぎた枠に重ねない（パネルの見出しの「◯ 時点 · ◯前の値」は出したまま。週のゲージがいつの値かを言う）。
- `resetLabel()` は、過ぎた時刻を `RESET_SOON_MS`（5 分）までは「まもなく戻る」、それより前は「◯/◯ ◯:◯ に戻った」と言う（`past` を付けると直後でも「戻った」。更新待ちの脇で使う）。

### 共通

- パスはホームと `CODEX_HOME` から固定で組み立て、リクエストからは受けない。
- `UsageStore` のコンストラクタは置き場（codex / claude / feed dir）に既定値を持たない。本番の組み立ては `createApp` の既定値にだけある。
- 3 秒のポーリングには乗せず 30 秒キャッシュ。
- 行の読み方（`parseCodexUsage` / `parseClaudeUsage`）と言い換え（`resetLabel` / `windowLabel` / `usageLevel`）は `shared/usage.ts`（`shared/usage.test.ts`）。

### 画面

- ヘッダの `UsageChip`。`useUsage.ts` が開いたとき・タブに戻ったとき・パネルを開いたときだけ取る。取れなければ何も出さない。
- チップに何をどの順で出すかは `web/src/usageChips.ts` の `usageChips()` / `chipsLevel()` に 1 つだけ置く（#347。`usageChips.test.ts`）。Claude が先。Claude は 5 時間の枠が無ければ週に落として `週` の印を付ける。上限中は割合が無くても出す。
- 割合が古いか（#694）は `shared/usage.ts` の `isUsageStale(at, now)`（`USAGE_STALE_MS` = 30 分。`at` が無い・読めない・先の時刻・`now` が 0 なら古いと言わない）、言い換えは `usageAgeLabel()`（「27時間前」）と `usageAtLabel()`（今日でなければ日付も）。画面に渡す形は `web/src/usageChips.ts` の `claudeFreshness(claude, now)`（`at`・`age`・`stale`・`fiveHourMissing`）の 1 つで、**測る起点は `at`**（返信の出力から拾った値では届いた時刻、ステータスラインの値では割合が最後に変わった時刻。後者は届いているが変わっていない値にも付くので、文言は「◯ 前の値」）。`useUsage.ts` は表に出ているあいだ `USAGE_REFRESH_MS`（5 分）おきに取り直す（取り直さないと `now` が進まず、開いたままのタブで印が付かない）。`usageChips(usage, now)` の `stale` / `age`、`UsageChip` の title、`UsagePanel` が同じものを見る。古さを見るのは割合があるときだけ（上限中だけの記録の `at` は transcript の行の時刻）。理由の文は `CLAUDE_USAGE_WHY`。捨てる上限との関係: `USAGE_STALE_MS` < `STATUS_MAX_AGE_MS` で、30 分〜8 日は印を付けて出し、8 日を過ぎたら `parseStatusLineUsage()` が今までどおり落とす（`shared/usage.test.ts` が順を見る）。
- **SAI から回した返信の出力から割合を拾う**（#694）。`claude -p --output-format stream-json` は API の応答ごとに `{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.14,"resetsAt":…},"seven_day":{…}}}}` を出す。
  - 渡す: `ProcessRunner` は第 4 引数の `ClaudeLimitsSink`（`server/reply/claudeLimits.ts`）に、result の見張り（`RESULT_POLL_MS`）が読んだかたまりを渡し、ターンが終わったときは**見張りがまだ渡していない末尾だけ**（`limitsPos` から後ろ）を渡す。頭から渡し直すと、何時間も前の知らせに「いま届いた」と刻む（#723 のレビュー）。**見張りの無い返信（入力の口を開けていない・立て直しで引き取った子）の出力は、いつ届いたか分からないので渡さない**。止めたターンでも渡す（口座の値なので）。最後に `flush()` を呼ぶ。
  - 置く: `ClaudeLimitsFile.observe()` は `shared/usage.ts` の `lastRateLimitEvent()` → `parseRateLimitEvent()`（`utilization` 0〜1 を % に。割合の無い知らせは null）で最後の知らせを取り、`usage-claude.json` と同じ形（`v`・`ts` = 届いた時刻・`source: "replies"`・`rate_limits`）で tmp → rename する。**値に依らず `LIMITS_WRITE_MS`（10 秒）に 1 回まで**（知らせは応答ごとに来て値もほぼ毎回変わる。同期の書き込みをイベントループに並べない）。間引いた値は `pending` に届いた時刻ごと覚え、次の知らせか返信の終わりの `flush()` で**届いた時刻のまま**書く（最後の知らせを落とさない）。書けたときだけ片付け、書けなければ次でまた試す。時計が戻ったときは間引かない。書けなくても返信は止めない。
  - 名前: `replyLimitsFile()`（マシン名は `server/host.ts` の `selfHost()`）。既定は `usage-claude-replies.json`、**`AGENT_FEED_HOST` を設定したときだけ** `usage-claude-replies.<host>.json`（`statusline.py` の `usage_file()` と同じ規則）。`isClaudeUsageFile()` には当たらない（ステータスラインのファイルとして読まれない）。
  - 読む: `readReplyLimits()` と `readStatusLineUsage()` は同じ `readUsageFiles()`（名前の述語だけ違う）で、当たるものを全部読んで新しいものを採る（同じ `parseStatusLineUsage()`。期限切れの窓・8 日より古いものは落ちる）。
  - まとめる: `UsageStore.read()` が `mergeUsageWindows(ステータスライン, 返信)` → `mergeClaudeUsage()`（上限中を重ねる）。窓ごとに選ぶ。**返信のほうが新しければ返信の窓**（高いステータスラインの値は混ぜない。返信に無い窓だけステータスラインから）。ステータスラインのほうが新しければそちらの窓だが、同じ窓（`SAME_WINDOW_SECONDS` = 60）で返信より低いものは持ち回りの古い値なので返信のほう、無い窓も返信から。**混ぜたときの `at` は古いほうの出どころの時刻**（新しく見せない）。
  - `createApp` に runner を渡すテストでは何も書かれない（本物の `ProcessRunner` を組むのは既定のときだけ）。
- パネルの「ステータスラインを設定すると出ます」の案内は、割合が 1 つも無いときだけ出す。

## rev が同じなら 304（#592）

- `app.ts` の `jsonByRev()`。一覧・詳細・フィードの 3 つだけが通す。`ETag` は `rev` の sha1 の頭 20 桁で、`If-None-Match` が合えば本文を作らずに 304。
- rev を組むまでの仕事（行の集計・走査の結果）は減らない。減るのは JSON にする・送る・画面がパースする分。
- `X-SAI-Build` は 304 にも付く（`watchBuild` が見る）。

## ビルドへの追従

- サーバは `web/dist/` を毎回ディスクから読み、`/api/*` に `X-SAI-Build`（`dist/index.html` の mtime）を付ける。
- `web/src/api.ts` の `watchBuild` がポーリングのついでにそれを見て、変わっていたら `location.reload()` する。`pnpm dev` 中は HMR に任せて何もしない。
- サーバ側の再起動は `pnpm start:watch`。

## ビルドが古いことの判定（local/buildFreshness.ts）

- `server/local/buildFreshness.ts` が `web/dist/index.html` と `web/src` / `web/index.html` / `shared`（`*.test.ts` を除く）の mtime を 30 秒に 1 回比べる。
- 結果は `/api/sessions` と `/api/feed` の `build_stale` に載せ、`rev` にも混ぜる。
- `App.tsx` はそれでヘッダの下にバナーを出す（`pnpm dev` では出さない）。
- git は叩かない。

## フックの配線のずれ（local/claudeHooks.ts）

`SessionsResponse.hooks_missing` → `App.tsx` のバナー（#567）。

- あるべき一覧は `shared/hooks.ts` の `EXPECTED_CLAUDE_HOOKS`。README「1. フックを向ける」の JSON の例と `server/docs.test.ts` が突き合わせる。
- 判定は同じファイルの `claudeHookGaps()`（純粋関数）。「このコマンドは `record.py` に届くか」は関数で受ける。
- 届くかは `server/local/claudeHooks.ts` の `reachesRecord()`。`/setup-sai` の `reaches()` と同じ規則で、コマンドに `record.py` を含むか、先頭の語をサーバの `PATH` で引いたスクリプトの中身が呼ぶか。
- `ClaudeHooks` は `~/.claude/settings.json` を読むだけ。30 秒に 1 回 mtime を見て、変わったときだけ読み直す（3 秒のポーリングで読まない）。
- 行からは分からないので設定を見る。
- 分からないなら出さない: 届くフックが 1 つも見えない（ラッパーがサーバの PATH に無い・別の置き場で繋いでいる）ときは `null`。窓にこのマシンの Claude の行が無いときも出さない。
- 本物の設定を読むのは `main.ts` だけ（`TerminalDeps.claudeHooks`）。`createApp` の既定は `NoClaudeHooks`（読まない）。
- `/setup-sai` は同じ判定を `node server/hooksCheck.ts` で回す。
- 足りない値は rev にも混ぜる（直したら次の行を待たずに消える）。

## Claude のログイン切れ（local/claudeAuth.ts。#685）

- `ClaudeAuth.check()` が `claude auth status --json` を起こし、`parseAuthStatus()` が `loggedIn` と `authMethod` だけを読む（`email` / `orgName` などは持たない）。終了コードは見ず、stdout の JSON を読む。`claude` が無い・古い・時間切れ（`AUTH_TIMEOUT_MS` = 5 秒）・壊れた出力は `undefined`（分からない）で、前の結果も捨てる
- 走っている 1 本を待ち、`AUTH_CACHE_MS`（5 秒）の間は聞き直さない（返信がまとめて失敗しても 1 回）。`peek()` は前の結果を返すだけで `claude` を起こさない
- 聞くのは 3 か所だけ: `main.ts` の起動時、`app.ts` の `withAuth()`（Claude の返信が失敗したとき）、`POST /api/claude-auth/check`（画面の「確かめ直す」。同一オリジンのみ）
- `withAuth()` は `replyingOf()` の結果を受け、**プロセスが非 0 で終わった失敗**（`code` があり `turn_error` でない）のうち、Claude のものを見る。Claude かどうかは起こしたコマンド（`startedBin`。行の無い新しいセッションもこれで分かる）、無ければセッションの行で決め、どちらでも分からなければ聞かない（Codex・OpenCode の失敗に Claude のログイン切れと出さない）。`revWith()` は `logged_out` も混ぜる。失敗 1 つ（`<id>` と `since`）につき 1 回だけ `check()` を待ち、`loggedIn: false` なら `failed.logged_out: true` を付ける。**失敗が最初に見えた応答で待つ**のは、画面（`useReply`）が失敗を 1 回しか読まないため
- 一覧は `peek()` が `loggedIn: false` のときだけ `claude_logged_out: true` を載せ、`rev` に混ぜる。画面は `web/src/ClaudeAuthBanner.tsx`（文は `claudeAuthNote.ts`）
- 本物を渡すのは `main.ts` だけで、`createApp` の既定は `NoClaudeAuth`（聞かない）

## SAI からログインし直す（local/claudeLogin.ts。#577）

- `ClaudeLogin` が `claude auth login` を子として起こす（stdin / stdout / stderr とも pipe。TTY は要らない）。起こすのはこの 1 形だけで、`logout` / `setup-token` は起こさない。本物を組むのは `main.ts` だけで、`createApp` の既定は `NoClaudeLogin`（何も起こさない）。
- 状態は `idle → starting → waiting ⇄ sent → checking → done / failed`（`shared/types.ts` の `ClaudeLoginResponse`）。**手順を持つのはサーバ**で、画面は映すだけ。
- **切れていると分かっているときだけ起こす**: `start()` は起こす前に `recheck`（`ClaudeAuth.refresh()`。数秒前の結果を使わない）を聞き、`loggedIn: false` 以外なら子を起こさず `failed`（`logged_in` / `unknown`）。この門は口（`app.ts`）ではなく `ClaudeLogin` の中にある（どこから呼んでも通る）。
- **状態を持つのは「いまの子」（`running`）だけ**。SAI が落とした子（やめた・時間切れ・URL が出ない）は `drop()` で `running` から外して `dying` に移し、その出力・時間切れ・終了は画面の状態に触らない（落とした子の URL を、次の回のものとして出さない）。次の子は `drained()` で前の子が全部終わってから起こす（同時に生きているのは 1 本）。
- もう進んでいるとき（始めている途中 `opening`・子が待っている・結果を聞き直している `settling`）の `start()` は何も起こさず、いまの状態を返す。別のタブ・描き直した画面は同じ子の続きに乗る。
- URL は `loginUrl()` が stdout から取る: 端末のリンクの印（OSC 8）を外し、**https・Anthropic のホスト（`claude.com` / `claude.ai` / `anthropic.com` とその下）・`redirect_uri` があって `localhost` でないもの**（コードを表示するページへ戻る方。戻り先の無い案内のリンクは採らない）。後ろに区切りが来ているものだけを取る（出力の切れ目で途中までの URL を出さない）。子が先に別の URL を出しても、それをリンクにしない。
- **Mac のブラウザを開かせない**: 子は PATH の `open` を呼ぶので、`<feed dir>/login-shim/` の下に**起こすたびに 0700 のディレクトリを作り**（`mkdtemp`）、そこに何もしない `open` / `xdg-open` を `wx`（既にあれば書かない）で置いて、子の `PATH` の先頭に足す。子が終われば消す。前から置いてあるファイルは PATH に載らず、仕込まれたシンボリックリンクも辿らない。`PATH` が空なら `/usr/bin:/bin` を後ろに付ける。前にサーバが落ちたときの残り（`p-*`）は、1 時間より古いものだけ片付ける（同じ置き場を使う別のサーバの、走っている回のものを消さない）。「実行ファイルは PATH から探す・差し替えない」の例外はこの子だけ。
- コードは `loginCode()`（空白を含まない ASCII の印字できる字だけ・`LOGIN_CODE_MAX` = 2048 字まで。1 回の POST で子に 2 行ぶん渡させない）を通して子の stdin に書くだけ。変数にもファイルにも残さない。子が `Invalid code` と言えば `waiting`（`note: 'invalid_code'`）に戻る。この文言が変わっても `sent` のままコードは渡し直せる（画面も送るボタンを止めない）。持つ出力は 64KB までで、超えたら末尾 8KB だけ残す。
- 子は自分では終わらない（stdin を閉じても待つ）ので、`LOGIN_TIMEOUT_MS`（10 分）で落とす。URL が `LOGIN_URL_WAIT_MS`（20 秒）出なければ `no_url` で落とす。落とすのは SIGTERM、`LOGIN_KILL_GRACE_MS`（3 秒）で終わらなければ SIGKILL。子の終わりは `exit` で見る（`close` だと、包みのスクリプトの孫が出力の口を持ったままのとき終わりにならない）。`error` は起こせなかったとき（pid が無い）だけ終わりとして扱う。
- サーバの `dispose()`（`stop()`）は、すぐプロセスが終わるので**待たずに SIGKILL し、置き場も同期で消す**。そのあとの `start()` は起こさない（`unavailable`）。
- **コードを渡したあと、子が終わらない版に備える**: `LOGIN_SENT_RECHECK_MS`（渡してから 5 / 15 / 40 秒）に `recheck` を聞き、ログインできていたら子を落として `done`（ログの `ended_by` は `logged_in`）。できていなければ何もしない。
- **「できた」は終了コードで決めない**: 子が自分で終わったら（時間切れ・URL が出ないときも）`recheck` を聞き、`loggedIn: true` なら `done`、違えば `failed`。やめた子の結果は聞かない。一覧の `claude_logged_out` も同じ読み手なので、次のポーリングでバナーが消える。`ClaudeAuth.refresh()` は同時の呼び出しで 1 回を分け合い、聞けなかったら前の結果を残す（`check()` は「分からない」に戻す）。
- `claude-login.log` に、子が終わるごとに数だけを残す（終わり方・終了コード・シグナル・時間・出力の行数とバイト数・コードを渡した回数・聞き直した結果）。**正しいコードを渡したあとの振る舞いは実物で確かめていない**ので、次に本当に切れたときにここで見る。
- 口は `GET` / `POST /api/claude-auth/login`（`app.ts`）。同一オリジンのみ・`no-store`。`start` / `code` / `cancel` を `ClaudeLogin` に取り次ぐだけ。タグ付きの端末は手前で 401。
- 画面は `ClaudeAuthBanner` → `ClaudeLoginPanel`。人が押して開いたら `start` を送り（進んでいれば続きが返る）、描き直しで開き直したとき（`resume`）は状態を聞くだけで始めない（何も進んでいなければ黙って閉じる）。最初の応答が返ってから、走っている間だけ 2 秒ごとに状態を聞く（一覧のポーリングには載せない）。**子を落とすのは「やめる」を押したときだけ**（描き直し・別のタブを閉じたことでは落とさない。放っておいた子は 10 分で落ちる）。バナーは一覧の `claude_logged_out` が立っている間だけ描かれ、絞り込みを変えると一瞬消えるので、開いていたことは `claudeLoginOpen.ts` が 10 分だけ覚える（ログインできた・閉じたら忘れる。古い印で次に勝手に始めない）。操作より前に出した問い合わせの応答では上書きしない。進んでいた手順がこの画面の外で止まったら（別の画面でやめた・サーバを立て直した）、その旨を出す。文は `claudeLoginNote.ts`、時間切れの長さは `shared/claudeLogin.ts` の 1 つ。

## 返答に出てきたファイルを読む（local/files.ts。#603）

- `GET /api/sessions/<id>/files/<key>`。画像（`local/images.ts`）と同じ作りで、**パスはリクエストから受けない**。`fileTable()` がそのセッションのターン完了の行の本文から `shared/files.ts` の `fileRefs()`（`` `コード` `` のうち `fileRefOf()` がパスの形と見たもの。拡張子は `TEXT_EXT` の一覧）で拾い、`fileKey()`（`imageKey()` と同じ）の鍵で引く。自分の入力・待ちの行・`thinking` は見ない
- `readSessionFile()` の順: 書かれた名前が `isSecretPath()` に当たれば 403 → cwd と対象を `realpath` → cwd の外は 403 → **リンクを解いた先の相対パスでももう一度 `isSecretPath()`** → `O_NOFOLLOW` で開く → ファイルでなければ 404 → `FILE_MAX_BYTES`（1MB）超は 413 → `decodeText()`（NUL を含む・UTF-8 として読めないものは 415）。返すのは文字と名前だけ
- **出す相手は `app.ts` が決める**: `who.kind !== 'local'`（Serve のヘッダ付き）は 403、`Host` がループバックの名前でない（`isLoopbackHostHeader()`。DNS の付け替えへの備え）も 403、別のマシンのセッションは 404。応答は JSON（`SessionFileResponse`）で、ファイルそのものを `text/html` などで配る口は無い
- 画面: `Inlines` の `code` は `CodeSpan`。`FileSessionContext`（`Chat` がバブルごとに渡すセッション ID。自分の入力・別のマシン・一言の行・ビューアの中は null）と `FileOpenContext`（`FileViewerProvider`）があり、`fileRefOf()` が当たるときだけボタンにする。ビューアは `FileViewer`（開いたときに 1 回読む。別のファイルは `key` で作り直す）。元の文字は行番号と本文の 2 つの `<pre>`（行ごとに要素を作らない）で、行の高さは `FILE_LINE_H`（18px。CSS の `--file-line-h` と揃える）に固定し、飛び先の印とスクロール位置を行番号から決める。出し方・行の分け方は `web/src/fileView.ts`
- テスト: `shared/files.test.ts` / `server/local/files.test.ts` / `server/session-files.test.ts`（本物の `createApp`。tailnet 越し・名前で断るもの・パスそのものを渡したもの）/ `web/src/fileView.test.ts`

## 画像の軽い版（local/thumbnails.ts）

枠（バブルの下 96px・本文の中 最大 320px・添えた画像）に元の画像を読ませないための `?thumb=1`（#589）。

- 口は 4 つ（`/images/<key>`・`/transcript-images/<key>`・`/codex-images/<key>`・`/api/attachments/…`）。前の 3 つは `app.ts` の `sendImage()`、添付は同じ形をその場で書く。**どれも今の読み方で読み終えたバイト列**（realpath が置き場の中・中身で種類を判定・上限以下）を `ThumbMaker.thumb()` に渡すだけで、`?thumb=1` で読む条件は変わらない。
- `Thumbnails.thumb()` は、`THUMB_MIN_BYTES`（200KB）未満なら `original`（元のまま）。それ以上はバイト列を置き場（feed dir の `thumbs/`）に `<sha256 の頭 32 桁>.src` として書き、**そのパスだけ**を `sips` に渡す（`sipsShrink()`。形は決め打ち・`execFile`・15 秒の締切）。出来たものは `<ハッシュ>.jpg|png` に置き、次からはそれを読む（鍵が中身なので古くならない）。
- 形式は `hasAlpha()` で決める: JPEG と透過の無い PNG は長辺 512px の JPEG（品質 75）、透過のある PNG（IHDR の色の種類 4 / 6、IDAT より前の `tRNS`）・GIF・WebP は長辺 384px の PNG。縮めても元より重ければ `original`。**`sips -Z` は小さい画像を引き伸ばす**ので、`imageSize()`（PNG / GIF / WebP / JPEG の見出しから縦横を読むだけ）で長辺が目標以下なら、PNG にするものは `original`、JPEG にするものは大きさを変えずに作り直す。
- **横に細長い画像（帯）は長辺を伸ばす**（#709）: `thumbTarget()` が、`shared/images.ts` の `isBandImage()`（幅 ÷ 高さが 4 以上。画面の `bandLayout()` と同じ見分け）なら、短辺が `THUMB_BAND_SHORT`（120px）になる長辺を返す（ふつうの長辺以上・`THUMB_BAND_EDGE_MAX` = 2048px 以下）。置き場の名前は `<ハッシュ>-<長辺>.jpg` に分け、前に長辺 512px で作った帯の軽い版を返さない。軽い版の ETag の頭は `t2-`（大きさの決め方を変えたら上げる。上げないとブラウザの持っている古い軽い版が 304 で使われ続ける）。
- 同じ中身を同時に頼まれたら 1 回だけ縮め、同時に回す `sips` は 2 つまで。置き場は 1000 枚を超えたら古いもの（mtime）から捨てる（50 枚作るごとに見る）。
- `sips` が無い（`ENOENT`）・失敗・締切は `unavailable` で、`sendImage()` は `503` + `X-SAI-Thumb: unavailable` + `X-SAI-Image-Bytes` を返す。`sips` が無いと分かったら以後は呼ばない。縮められなかった中身は 10 分覚えて回し直さない（`THUMB_FAILED_TTL_MS`。画面の見分けの HEAD がすぐ返る）。
- 軽い版の `ETag` は元の `ETag` に `t-` を付けたもの。`download=1` のときは `thumb=1` を見ない。
- `createApp` の既定は `new Thumbnails(join(store.directory, 'thumbs'))`（テストの feed dir は一時ディレクトリ）。テストは `TerminalDeps.thumbs` に偽の縮める口を渡した `Thumbnails` か `noThumbs`（縮めない）を渡す。
