# 返信の仕組み

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/reply.md](../history/reply.md)。

画面の見え方は [screen.md](../screen.md) の「チャット」〜「返信と許可」、口の形は [api.md](../api.md)。ここはコードのどこで何をしているか。

## 経路

`POST /api/sessions/<id>/reply` は次の順に選ぶ。

1. セッションが tmux のペインで開いていれば（行の `pane` / `pid`、pid が生きている）端末に打ち込む（下の「端末」）。ペインが消えていれば下へフォールバック。
2. 閉じた Claude は `server/reply/runner.ts` が `claude -p --resume` を detached 起動する。
3. 閉じた Codex は `server/reply/codexAppServer.ts` が長寿命の `codex app-server --stdio` へ接続して `thread/resume` → `turn/start` する（`SAI_CODEX_APP_SERVER=0` だけ従来の `codex exec resume`）。
4. 開いている Codex（writer lock。補欠で記録時の pid）は `server/reply/codex.ts` が `codex queue --thread ... --message ...` の終了まで待って、開いている会話へ足す（下の「Codex」）。
5. OpenCode は `server/reply/opencodeServer.ts` が長寿命の `opencode serve` へ HTTP で送る（#382。`POST /session/<id>/prompt_async`。`SAI_OPENCODE_SERVER=0` だけ従来の `opencode run -s`）。

- 結果は既存のフックが JSONL に足す 1 行として届くので、返信専用の記録経路は無い。app-server の経路も `reply.log` に 1 行残す。
- 返信できるかの判定は `shared/reply.ts` の `replyBlockedReason()` にあり、画面側は `web/src/useReply.ts` が管理する。

## 端末（tmux）

- `server/reply/terminal.ts` がペインに打ち込む（`load-buffer` → `paste-buffer -p` → `send-keys Enter`）。入力中・ダイアログ中なら 409。
- 処理中（`TerminalReplies`）は、ターン完了の行が届いたら解消する。
- 端末に打ち込んだ・queue に渡した返信は、届いたかを確かめる: `TerminalReplies.checkDelivery()` が `TERMINAL_DELIVERY_WAIT_MS`（2 分）経ってもターンが始まっていない（Claude は `last_user_ts`、Codex は `ProgressReader` の `updated_at` が送った時刻より古い）ものを `failed`（終了コードの無い `ReplyFailure`）にして画面に出す。材料が無い（OpenCode・別のマシン・読めない）ときは届いた扱い。

## 子プロセスの環境（childEnv）

- SAI が起動する子（`claude -p` / `codex exec resume` / `codex queue` / `codex app-server` / 一言の `claude -p`）には `runner.ts` の `childEnv()` を通した環境を渡し、`TMUX_PANE` を落とす（#234）。
- `isDescendant()` はペインの取り違えを弾けない（`-p` の子はサーバの子孫で、サーバはそのペインの子孫なので条件を満たす）ので、ここで落とすしかない。
- 落とすのは `TMUX_PANE` だけで `TMUX` は残す（ターンの中で `tmux` を使うことはある）。

## 終わらない CLI（行が届いたら終わりにする）

- 答えを返したのにプロセスが終わらない CLI は、行が届いたら終わりにする（#375。`ProcessRunner.settle()`）。
- 判定は `shared/turnSettled.ts` の `settledByRow()` で、`TerminalReplies.settle()` と同じ 1 つを使う。行の `ts` は秒までなので `since` を秒に丸めて比べる。
- 終わりにしたら残った子は kill する（放っておくと溜まる）。
- 当てるのは `app.ts` の `opencodeTurnOf()` が OpenCode のセッションにだけ `last_turn` を返すからで、普通に終わる Claude の `-p` と SAI 管理の Codex の挙動は変えていない。

## 使用量

SAI が起こした Claude のターンは、使ったトークンと費用も残す（#387）。

- `claudeHead()` が `--output-format stream-json` を付ける（#386 で `json` から変えた。運用者が自分の `--output-format` を指定していればそちら。`stream-json` でも最後の result の行から読める）。
- `ProcessRunner` が終わったときに reply.log のそのターンぶん（`logOffset` 以降）を 1 回読んで `shared/turnUsage.ts` の `parseTurnUsage()` に通し、`<feed dir>/turn-usage.jsonl` に 1 行足す（`server/reply/turnUsage.ts`）。
- 子の stdout はログの fd に直接書かせたまま（pipe にしない）。
- result が無ければ何も書かない（Codex / OpenCode はこの形を返さない。引き取った子は exit を受け取れないので残らない）。
- 記録（`YYYY-MM-DD.jsonl`）は触らない（digest.jsonl と同じ派生データ）。
- 失敗の理由（`ReplyFailure.tail`）は JSON の切れ端ではなく CLI の本文にする（`failureTail()`）。
- 画面は `web/src/TurnUsageTag.tsx`（#411）。
- どの行のぶんかは `shared/turnUsage.ts` の `usageByRow()`: その使用量の `ts` 以前で一番新しい、同じエンティティのターン完了の行で、差が `USAGE_MATCH_MS`（2 分）以内のものだけ。向きは「行 → 使用量」で、後ろの行は見ない。行の `ts` は `+09:00`・使用量は `Z` なので文字列ではなく時刻で比べる。
- 読む側は `TurnUsageLog` 自身（書く側と同じ 1 つを `createApp` が持つので、追記した分はそのままメモリに載り、3 秒のポーリングでファイルを読み直さない）。起動時に読み返すのは `TURN_USAGE_KEEP_DAYS`（90 日）ぶんだけで、ファイルは切り詰めない。
- `rev` に `usage.rev()` を混ぜる（使用量は行より 1〜2 秒遅れて届くので、混ぜないと次の行が来るまで画面に出ない）。

## Codex

### queue（開いている Codex）

- lock はファイルがあるだけでは数えず、開いているプロセスがいるときだけ（`codexWriterActive()` が `lsof -t`。#329）。`lsof` が無ければファイルがあれば開いている扱い。
- SAI の app-server が読み込んでいるスレッド（`CodexApp.holds()`）は queue に回さない（app-server は `thread/resume` したスレッドの lock をターンが終わっても開いたままにする）。

### queue に渡した返信が届いたか（#474）

- 送った本文そのものが rollout に現れたかで見る（`shared/codexQueue.ts` の `queuedTextArrived()`）。rollout は `ProgressReader.codexRollout()` で引き、末尾 `QUEUE_ROLLOUT_TAIL_BYTES`＝4MB だけ読む。見つからなければ mtime に落ちる。
- `codex queue` は受け取られたかを返さない（`--help` に状態を返す口が無く、既定の送り先は共有の `unix://` app-server）。
- **`QUEUE_DELIVERY_WAIT_MS`（30 秒）**で確かめ、失敗は **`QUEUE_FAILED_TTL_MS`（30 分）**見せる。失敗にしたものは処理中ではないので、長く残しても次の返信は止めない。
- 宛先がターンの途中なら判定を保留して次のポーリングで聞き直す（`turnInProgress()`。末尾の最後のターンの印が `task_started`、または印が読んだ範囲に無くても書き込みが続いている。最後の書き込みが `QUEUE_BUSY_STALE_MS`＝10 分より古ければ途中とみなさない。`turn_aborted` も閉じる印）。聞き先が `null` を返すと `checkDelivery()` は届いたとも失敗ともしない。
- 握っているのが `codex app-server` なら理由に pid を書く（`codexLockHolders()` / `isAppServer()`）。
- 届かなかったことは reply.log にも 1 行残す（`checkDelivery()` が新しく失敗にしたものを返す）。

### エラーで終わったターン（#475。`shared/codexTurnError.ts`）

- エラーで終わったターンでは Codex は `notify` を鳴らさないので、record.py が呼ばれず行が 1 本も残らない。SAI 側で失敗として出す。
- 端末に打ち込んだ・queue に渡した返信は、届いたと確かめたあと `TerminalReplies.checkTurnEnd()` が `queuedTurnError()` を聞く（送った本文のあとのターンの終わりが `task_complete.error` か。前のターンのエラーは数えない・`turn_aborted` は人が止めたので数えない）。rollout は `(size, mtime)` が変わったときだけ読む。
- SAI の app-server で回した返信は、`CodexAppServer` が `turn/completed` の `status: "failed"` を `failures` に残して `replying()` に載せる。
- どちらも `TURN_ERROR_TTL_MS` / `CODEX_TURN_FAILED_TTL_MS`（30 分）見せ、reply.log にも 1 行残す。
- `error.message` は API の応答を JSON にした文字列のことがあるので、`codexErrorText()` が中の `message` を採る。
- 行は起こさない（記録の正本は record.py）。

## OpenCode

### serve へ送る（#382）

- 前提（1.18.30 で確認）: サーバでもプラグインは動くので返信ぶんも普通のターンとして記録される。セッションは ID だけで引けてそのセッションの cwd で走るので、worktree ごとにサーバを起こさなくてよい。`OPENCODE_SERVER_PASSWORD` を渡せば鍵の無いリクエストは `/doc` も含めて 401。
- ワンショットを起こさないので、答えを返しても終わらない子（#375）が出ず、許可の自動 reject（#273）にも当たらない。
- 子プロセスが無いので `exit` は来ず、行が届いた時点で終わりにする（`OpencodeServer.settle()`。#375 と同じ `settledByRow()`）。処理中の判定（`running()`）にも混ぜるので、預かり（#305）はそのまま効く。

### 許可に画面から答える（#421。`server/reply/opencodePermissions.ts`）

- 画面の 3 秒のポーリングのついでに `GET /permission?directory=<セッションの cwd>` を引く。`directory` が要る（`/command`（#393）・`/config/providers`（#394）と同じ。サーバは homedir で動いているので、渡さないと保留があっても `[]`）。
- 聞くのは回しているか行の上で待っている OpenCode のセッションの cwd だけで、どちらも無ければ 1 本も投げない。
- 記録にあるセッションの分を `Approval`（`agent: 'opencode'`、`answerable: true`、`decisions` = 許可 `once` / 拒否 `reject`）にし、押された答えを `POST /session/<id>/permissions/<per_…>` に流す。答える口は既存の `POST /api/approvals/<id>/answer` に相乗り（新しい API は無い）。
- 保留を見るためだけにサーバは起こさない（`OpencodeServer.live()` は立っているものだけを返す。`serve()` との違いはそこだけ）。
- 保留は v1 の `GET /permission` にだけ出る（v2 の `/api/session/<id>/permission` は空で、逆に v2 の口で作った要求は v2 にしか出ない）。
- 「常に許可」（`always`）は出さない（`patterns` の glob に効くので押した範囲が本人に見えない）。
- 答えられるのは SAI が起こしたサーバが持っている保留だけで、端末の TUI と人が立てた別のサーバには触れない（Codex の `turn/interrupt` と同じ線引き）。
- 行の待ちの文言は `許可待ち: external_directory: /etc/hosts` まで出す。`metadata` のキーは大文字小文字を見ない（実物は `filepath`）。
- 規則は `shared/opencodePermissions.ts` にあり、プラグイン（`feed/opencode/sai.js`）が同じ規則を JS で持つ。`shared/opencodePermissions.test.ts` と `server/opencodePlugin.test.ts` に同じ payload と同じ期待文字列を置いてある（片方だけ変えるともう片方が落ちる）。
- `todoItems()` の OpenCode の待ちは `replyable: false`（返信欄から送っても許可は解けない。答えられる分は `answer` として上に出ている）。
- tmux を見ないので `SAI_TERMINAL` とは無関係。

### 答える相手が消えた待ちを畳む（#422）

- `OpencodePermissions.settle()` → `settleWaiting()`。判定は `shared/opencodePermissions.ts` の `settlesWaiting()`。
- 保留は聞いてきたプロセスのメモリの中にしか無いので、待ちの行を書いたプロセス（`SessionSummary.pid`。待っているセッションでは待ちの行そのもの）が生きていないか、保留を引けて（`ok`）その cwd も聞いていてそのセッションが保留に居ないなら畳む。
- いま保留があるものは畳まない。pid が 0（載っていない古い行）・別のマシン・引けなかった（サーバが立っていない）ときも畳まない（#255 と同じ「分からないなら残す」）。時間では畳まない。
- そのため `permissions()` は `{ ok, list }` を返す（引けないことと「保留が無い」を混ぜない）。
- `settleWaiting()` は畳む前の一覧で先に `scan()` してから `settle()` を呼ぶ（畳んだあとの `waiting` を見ると、そのセッションの cwd を聞きに行かなくなる）。

### 使わない口（#400）

表と理由は [screen.md の「返信と許可」](../screen.md#返信と許可)（`share` / `shell`・`/pty` / `--mdns`・`--cors`、`delivery: "steer"` は「まだ繋いでいない」）。

- `delivery` があるのは v2 の `POST /api/session/<id>/prompt`（`enum: ["steer", "queue"]`）だけで、SAI が使っているのは v1 の `prompt_async`（`delivery` は無い）。繋ぐなら v2 へ移る話とセットになる。

## 新しいセッション

`POST /api/sessions/new`（#314）。

### Claude

- 返信と同じ `ProcessRunner` で回す。`runner.ts` の `newSessionCommand()` が `claudeHead()`（返信と共通の前半。`SAI_CLAUDE_ARGS` → 許可の配線 → `--model` → `--permission-mode`）に `-p --session-id <uuid>` を付ける。
- ID はサーバが `randomUUID()` で決めるので、最初の行が届く前からエンティティ ID（`<uuid>@<from の repo>`）が分かり、処理中・許可の配線（`SAI_ENTITY`）・メタが返信と同じ鍵になる。
- `replyingOf()` は一覧に居ないセッションの分も返すので、行を書く前の失敗も `replying[id].failed` で画面に出る。
- 画面は `NewSessionView`（候補は `web/src/newSession.ts` の `workspaceChoices()`。`newSession.test.ts`）→ `NewSessionStarting`（`startStatus()`。詳細の GET が 404 の間はここで待ち、届いたら `#/s/<id>` へ移る）。

### Codex（#401。`NewSessionRequest.agent`。省略は `claude`）

- `CodexApp.startThread()` が `thread/start`（必須のパラメータは無く、`cwd` を渡すとその場所のスレッドになる）で id を作り、その id で `start()` を回す。
- 返る thread id はそのまま記録の `session` になる（rollout のファイル名も `session_meta.session_id` もその id）ので、最初の行より前にエンティティ ID が決まる。
- 作りたてのスレッドは rollout がまだ無く `thread/resume` が `no rollout found` で落ちるので、`CodexAppServer` は `thread/start` したスレッドを覚えておいて（`fresh`）最初のターンだけ resume を飛ばす（この接続がもう持っているので `turn/start` は通る。モデルも許可の宛先も `turn/start` の引数なので落ちない）。
- ターンを回すまで rollout は書かれないので、起動に失敗すれば記録には何も残らない。
- 許可モードは Claude にしか渡らないので、画面でも Codex のときは出さない。

### OpenCode（#452）

- `OpencodeServer.startSession()` が `POST /session?directory=<cwd>`。返る `ses_…` がそのまま記録の `session` になるので、最初の行より前に鍵が決まる。
- 作るのは長寿命の `serve` の中で、一発の `opencode run` では始めない（run は許可をその場で自動 reject する）。そのため `SAI_OPENCODE_SERVER=0` のときは選ばせない（`400`）。
- セッションを作っただけでは記録に行が 1 本も無い（プラグインは `session.idle` 起点なので、起動に失敗すれば何も残らない）。
- Grok は ID を先に決める口が無いので選べない。

## claude --bg

#462。`NewSessionRequest.background`。`server/reply/claudeBackground.ts` の `ClaudeBackground`、コマンドは `runner.ts` の `backgroundSessionCommand()`。あとから端末で `claude attach <短い ID>` すると TUI として開ける。

- 置き場は `--settings` の `env` で渡す（デーモンは起動した側の環境を継がない）。
- 許可の配線（`--permission-prompt-tool`）は付けない（使われない）。画面には「許可・質問は端末で attach して答える」と出す。
- `--session-id` は効かないので、ID は出力の `backgrounded · <短い ID>` から `claude agents --json --all --cwd` で UUID を引く。引けなくてもセッションはもう動いているので、`BackgroundLookupError` が短い ID を添えて返す（「始められなかった」と読ませて二重に始めさせない）。
- 生きている bg のセッションには `-p --resume` が断られ、`--bg --resume` は別のセッションに写す（止めたあとにフラグ無しで打つと同じ ID で起きるが、起動時の設定のまま）。
- そこで返信は `launch()` が `ClaudeAgents.background(raw, true)` で見て、生きている間は、誰も `claude attach` で開いていなくてターンも回っていないときだけ `claude stop` してから `-p --resume` する（会話は残り、attach すると SAI から送った分も入った状態で起きる）。どちらかに当たれば預かり（`Launched.retry` で `drain()` は止めずに待つ。見に行くのは `BG_RETRY_MS`（10 秒）おき）か `409`。止めた・終わったものはそのまま `-p --resume`。
- 開いている端末を見るのは `ps`（`ClaudeBackground.attached()` → `attachedIn()`）。argv に `claude` `attach` `<ID>` が続けて並ぶ行だけを数える。ID は短い ID・UUID・その頭（6 文字以上）のどれでもよい。`ps` が読めなければ「居る」扱いで止めない。
- ターンが回っているかは transcript で見る（`progress.read().active`。#302）。2.1.278 の `claude agents` はバックグラウンドの行に `state`（`working` / `stopped` / `done`）しか持たない（`status` も `pid` も無い）ため。2.1.276 の `status`（`busy` / `idle` / `waiting`）が来ていればそれも使う。`backgroundLive()` はどちらの版でも読む。
- 一覧はまず覚えているものを見て、バックグラウンドの行があるときだけ引き直す。
- `ClaudeAgents` は `--all` で引く（止めた bg も `claude attach` で起こし直せる）。`--all` を知らない版は非 0 で断るので、そのときだけ付けずに引き直す（引けないと #418 の打ち消しまで黙って止まる）。
- 詳細の応答の `background`（`BackgroundSession`）に載せ、`BackgroundAttachBar` がコマンドと状態を出す。
- SAI の子プロセスではないので `run.start` には載せない。

## 預かりと steer

#170 / #305 / #404。

- `app.ts` の返信は `run.running(id)`（`-p` の子プロセス）と `codexApp.running(id)` だけを処理中とし、端末に打ち込んだ返信が処理中（`TerminalReplies`）でもペインが開いていれば通す（TUI が次のターンに回す）。
- 別プロセスの経路が処理中なら、`ReplyRequest.queue` が付いていれば `server/reply/replyQueue.ts` の `ReplyQueueStore` に預けて `202`（`via: 'queued'`）、付いていなければ `409`。
- 起動は `launch()` → `startTurn()` に切り出してあり（応答を書かずに `Launched` を返す）、POST と `drain()`（預かりの先頭を 1 件起動する）が同じ経路を通る。
- `drain()` を呼ぶのは `-p` の exit（`run.start` の `onExit`）、SAI 管理の Codex のターンの終わり（`CodexApp.onTurnEnd`）、`/api/sessions` / 詳細 / フィードの応答を組むとき（再起動で引き取った子は exit を受け取れないので、ここで拾う）。
- 前の返信が `failed` なら回さずに止め（`paused` に理由）、画面の「続けて送る」（`POST .../queue/resume`）でその失敗を覚えて再開する。預かった返信を起動できなかったとき（409 / 500）も外さずに止める。
- 預かりが残っていれば処理中でなくても後ろに並べる（追い越さない。画面の判定は `web/src/replyQueue.ts` の `shouldQueue()`）。
- POST と drain が同じセッションを同時に起動しないよう、`launching` で spawn までの隙を塞ぐ。
- モデル・許可モードは回すときのメタを読む。
- 預かりは `reply-queue.json` にも書き（`replying.json` と同じ理由）、応答の `queued` と `rev`（`queue.key()`）に載る。
- 画面は `QueuedBubble`（取り消す・続けて送る）を処理中の仮バブルの下に出し、入力欄は止めずにボタンを「あとで送る」にする。
- フィードは `ReplyTarget.terminal`（`sessionReplyTargets` が `SessionSummary.terminal` から載せる）で判断する。

### steer（Codex の「今のターンに足す」。#404。Claude は下の「Claude の `-p` を止める・足す」）

- `ReplyRequest.steer` → `CodexApp.steer()` → `turn/steer`。既定は預かりで、画面で選んだときだけ足す。
- `turn/steer` は `{ threadId, expectedTurnId, input }`（`input` は `turn/start` と同じ配列）。`expectedTurnId` は守られる: 別のターンが走っていれば `expected active turn id X but found Y` で断り、終わっていれば `no active turn to steer`。どちらも `steer()` が false を返し、そのまま預かりに落とすので本文は落ちない。
- 足せるかの判定は `shared/reply.ts` の `canSteer()`（サーバと画面が同じ 1 つ。中身は #384 の `Replying.interruptible` と同じ条件＝SAI が `thread/resume` した、`turnId` の分かっているターン）。
- 足した文はそのターンの `input-messages` の末尾に載るので、`record.py` が `user_text` に採るのは足した方になる（元の指示はそのターンの行には残らない。rollout には両方ある）。
- 新しいターンではないので仮バブルは作らず、入力欄の下に「走っているターンに足しました」と出すだけ（次に送るかターンが終わると消える）。

## Claude の `-p` を止める・足す（#386）

- **返信 1 回 = 1 プロセスのまま**、入力の口（`--input-format stream-json`）を開けておく。`claudeHead()` が `--input-format stream-json --output-format stream-json --verbose` を付け、本文は argv ではなく stdin の `user` の 1 行（`claudeUserLine()`）で渡す。
- **運用者が自分の `--output-format` を指定していれば口は開けず、今までどおり `-- <本文>`**。
- `ProcessRunner` は stdin だけパイプにし（stdout は今までどおりログの fd に直接）、reply.log を `RESULT_POLL_MS`（0.5 秒）おきに読んで**そのセッションの `result`**（`hasResultFor()`。reply.log は並行する返信が混ざるので `session_id` まで見る）が出たら stdin を閉じる（閉じるとプロセスは終わる）。
- **口が開いている間だけ `Replying.interruptible`** を付け、`interrupt()` が `control_request` の `interrupt`（`claudeInterruptLine()`）、`steer()` が 2 通目の `user` を書く（`POST /api/sessions/<id>/interrupt` と「今のターンに足す」は Codex と同じ口）。
- **立て直しで引き取った子は stdin を持たない**ので印は付かず、止める・足すも出ない（そのターンは最後まで走る）。口の無い `-p`（引き取った子）への止める・足すは `400`。
- 止めた返信は失敗にせず（`Persisted.interrupted`）、使用量も残さない（止めたターンでは `Stop` が鳴らず結ぶ行が無いので、前のターンのバブルに付いてしまう）。
- 足した指示では `UserPromptSubmit` が鳴り（自分のバブルとして出る）、走っているツールが終わった直後に同じターンの中で取り込まれる。**`Stop` の行の `user_text` は元の指示のまま**（Codex は足した方になる）。
- 許可・質問の配線（`--permission-prompt-tool` + `approve-mcp`）はこの入力の形でも動き、使用量も stream-json の最後の `result` から読める（`parseTurnUsage()` はそのまま）。

## 打ちかけと失敗の戻し

### 端末の打ちかけ

- `promptState()` は `kind`（idle / typed / dialog / unknown）を返し、`typed` のときだけ 409 の body に `code: terminal_typed` と `typed` を載せる（`shared/types.ts` の `ReplyError`）。
- 画面（`useReply` → `ReplaceConfirm`）が確認して `replace_typed: true` で送り直すと、`typeInto()` が `C-u` を送り、再度 `capture-pane` で空を確かめてから貼る。dialog / unknown は消させない。
- 端末に打てない 409 は `can_process: true` を付け、画面に「端末を使わず送る」（`via: 'process'`）を出す。Claude は別プロセスで再開し、開いている Codex は queue へ送る。
- 入力欄は区切り線の直上の `❯` で見て、スラッシュコマンドの候補メニューは `Escape` で閉じてから `C-u`。

### 確認から送り直したら入力欄を空にする（#338）

- 送り直すのは `useReply` の `confirmReplace()` / `confirmProcess()` で、`ReplyBox.submit()` を通らない。
- `useReply` が受け付けた回数（`confirmedSent`）を数えて `ReplyBox` に渡し、`web/src/replySent.ts` の `clearsOnSent()`（`replySent.test.ts`）が増えたときだけ本文と画像を空にする（描画中に state を合わせる。effect の中で setState しない）。数で見るので、送り直したあとに打ち始めた本文は消さない。
- 「やめる」では本文を残す。

### 送信に失敗したら入力欄に戻す（#350）

- 判定は `web/src/replyRestore.ts` の `restoresText()` / `restoresImages()` / `restoresOnRequest()`（`replyRestore.test.ts`）。
- `submit()` は送る前に入力欄を空にして（送った直後から次を打てるように）、`onSend` が `false`（= `useReply.send()` が `'sent'` 以外）を返したら本文・画像・`@` の返信先を戻す。
- 戻すのは入力欄がまだ空のときだけ（いまの中身は閉じ込めた `text` ではなく textarea から見る）。
- 画像はサーバに置いたままなので `useAttachments` の `restore()` がパスごと戻すだけで預け直さない。
- 返信先も戻す（本文に `@名前` が残るので、戻さないと表記ごと本文として既定の相手に飛ぶ）。
- 非同期の失敗（`202` のあとプロセスが非 0 で終わった・記録が増えなかった・届かなかった）は `submit()` の外なので、`useReply` の `failed` に本文（`splitAttachments()` で画像のパスを外したもの）を載せ、「送信失敗: …」の横の「入力欄に戻す」を押したときだけ戻す（自動では流し込まない）。
- 預かり（#305）は `reply-queue.json` に残って `QueuedBubble` に出るので、そもそも失われない。

## 画像

返信に添える画像。

- `server/reply/attachments.ts` の `AttachmentStore` が `~/.agent-feed/attachments/<sha1(ID) の先頭16桁>/<sha1(中身) の先頭16桁>.<ext>` に置く（JSONL には書かない。ID からパスを組み立てない）。
- `ReplyRequest.attachments` の絶対パスは信じず、`resolvePath()` がそのセッションの置き場のものだけを通す（CLI に渡って読まれるため）。
- 受け付け条件と本文への足し方・取り出し方（`withAttachments` / `splitAttachments`）は `shared/attachments.ts`（`shared/attachments.test.ts`）。
- Claude は画像のフラグが無いので本文の末尾にパスを足すだけ、Codex は `-i` でも渡す（`server/reply/runner.ts` の `replyCommand`）。
- 画面は `web/src/useAttachments.ts` が預けて `ReplyBox` が貼り付け・ドロップ・ファイル選択で受け、`Message` / `PendingBubble` が `splitAttachments()` でサムネイル（`AttachedImages`）にする。

## 許可モード

返信の `--permission-mode`。

- 値は `SessionMeta.permission_mode`。UI は入力欄のモデルの右の `ReplyPermissionPicker`（#265。返信の設定は `[差分] [モデル] [許可]` と入力欄に集める）。
- `replyCommand()` が Claude にだけ `--permission-mode` として付ける（運用者の `SAI_CLAUDE_ARGS` より後ろで後勝ち）。そのターン限りでセッションには残らない。端末に打ち込む経路では効かない。
- 次の返信から効き、処理中のターンは起動したときのモードのまま（#272）。`replyCommand()` が付けたモードを `ReplyCommand.permissionMode` に持ち、`ProcessRunner` が `Replying.permission_mode`（`''` はフラグ無し、省略は分からない）として `replying.json` にも書く。画面はメタの値と違えば `shared/permissions.ts` の `launchedModeNote()` で、ボタンの横に「次の返信から」、許可のバブル（`SessionView` / `FeedView` / `TodoView`）に理由を出す。
- 選べるのは `acceptEdits` と `bypassPermissions`（#253）。`REPLY_MODES` に無い値（`auto` など）は画面に並べず、`mergeMeta()` が `400` にする。一覧は `shared/permissions.ts` の `REPLY_MODES` / `isReplyPermissionMode()` で、サーバの検査と画面のメニューが同じものを見る（閉じているときの短い名前は `shortReplyMode()`）。
- `bypassPermissions` を選んでいる間はボタンを赤くする（`modeSkipsRules()`。見出しのタグ・モーダルと同じ判定）。
- 名前（`MODE_LABEL` / `MODE_SHORT`）は英語（#271）。説明は `MODE_HINT`（日本語）に分けてあり、メニューの補足と `modeLabel()`（`Accept edits — ファイル編集は聞かない`。見出しのタグ・盾のモーダル）が使う。`server/approvals/permissions.test.ts` が名前に日本語が混ざると止める。

## モデル

返信で使うモデル。

- 入力欄の送信ボタンの左（`web/src/ReplyModelPicker.tsx`。#193）。選ぶと `PUT /api/sessions/<id>/meta` の `model` に保存する。
- 候補の組み立てと短い名前は `web/src/modelChoices.ts` の純粋関数（`modelChoices()` / `shortModel()` / `modelButtonLabel()`。`modelChoices.test.ts`）。
- OpenCode は本体にも聞く（#394。`GET /api/sessions/<id>/models` → `OpencodeServer.models()` → `GET /config/providers?directory=<セッションの cwd>`）。メニューを開いたときだけ取り（`web/src/useModels.ts`。`useSkills` と同じ形で、一覧のポーリングには載せない）、記録から組み立てた候補に重ねる（`modelChoices()` が `Set` で重複を落とす）。`/api/model` の全件ではなく `/config/providers` の設定済みの provider にする。`directory` を渡すとその worktree の `opencode.json` で足した provider まで出る。応答の形は `shared/models.ts` の `opencodeModels()`（`provider/model` にして出てきた順）。
- 選択肢の名前（`MODEL_DEFAULT_LABEL` = `Default` / `MODEL_CUSTOM_LABEL` = `Custom model…`）は英語（#282）。補足（`CLI に任せる`）・`title`・`ModelNameModal` の文言は日本語。名前を TSX に直書きしない（`modelChoices.test.ts` が日本語が混ざると止める）。
- 閉じているときだけ短く出し、メニューと保存する値は正式名のまま。候補に無い名前は `ModelNameModal`（`normalizeMeta()` で検査）。
- 見出しは `ModelTag` で使ったモデルを出すだけ（操作は入力欄の 1 か所）。フィードは `FeedView` がサイドバーの一覧から返信先のセッションを引いて渡す（一覧に無ければ出さない）。

## 別のマシン

#114。

- サーバは自分のマシン名を `server/host.ts` の `selfHost()`（記録側と同じ `AGENT_FEED_HOST` → `os.hostname()`。#288）で決めて `SessionsResponse.host` / `SessionDetailResponse.host` に載せ、集計は `SessionSummary.host` / `hosts`（一番新しい行のもの + 出てきた順）を出す。
- 判定は `shared/host.ts` の `isRemoteHost()` の 1 つだけ。`host` が空の行（古い record.py）とサーバの名前が取れないときはリモートにしない。比較は大文字小文字を無視し、`shortHost()` が `record.py` の `host_name()` と同じ規則で短くする。
- `replyBlockedReason()` は第 2 引数（サーバの host）を省略できない（呼び出し側の漏れは `pnpm typecheck` で止まる）。
- 印は `web/src/HostTag.tsx` の `@<host>` で、一覧・チャット見出し・フィードのバブル（`Chat` の `showChannel` のときだけ）に出る。絞り込みは `Facets.hosts` が 2 件以上のときだけ出す。
