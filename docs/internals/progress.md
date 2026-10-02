# 処理中の手順の仕組み

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/progress.md](../history/progress.md)。

画面から見た振る舞いは [screen.md](../screen.md) の「処理中の間は、いま何をしているかが出る」と「端末で開いた Claude が質問で止まると…」、応答の形は [api.md](../api.md) の `GET /api/sessions/<id>/progress` と詳細の `question`。

## transcript / rollout を読む

- `server/local/progress.ts` の `ProgressReader` が Claude の transcript（`~/.claude/projects/<cwd の英数字と - 以外を - に>/<session>.jsonl`。組み立てた名前に無ければ projects の直下を 1 段探す）と Codex の rollout（`CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<session>.jsonl`）の末尾だけを読む
- `shared/progress.ts` の `claudeProgress()` / `codexProgress()` が最後のターンの手順（ツール / 考え中 / 返答）にする（`shared/progress.test.ts`）
- ターンの区切り: Claude は人の入力（`isMeta` / 要約でない user の行）と assistant の `stop_reason`（`tool_use` なら続き、`end_turn` / `stop_sequence` なら閉じた）、Codex は `task_started` / `task_complete`
- 64KB から倍々に、ターンの始まりが見えるまで（上限 4MB）読み、`(mtime, size)` が変わらなければ組み直さない
- パスは行の `cwd` と、エンティティ ID から取ったセッション ID（`sessionOf()`。`/` や `.` を含む形と `unknown-` は空）で組み立てる。別のマシンのセッション（`isRemoteHost()`）は空

## active

- `progressActive()`: 「ターンが閉じておらず、走っているツールが 3 時間以内に始まっているか、最後の書き込みが 10 分以内」

## claude agents --json で打ち消す

- `server/local/claudeAgents.ts` の `ClaudeAgents`。出力は `{ pid, cwd, sessionId, kind: interactive|background, status: idle|busy, name, startedAt }` の一覧
- `status: busy` が 1 つも無いと分かったときだけ `active` を false にし、`rev` にも印を付ける（同じ rev だと画面が描き直さない）
- 同じ `sessionId` の行が複数出る（端末の TUI が `idle`、SAI が `-p --resume` で起こした子が同じ ID で `busy`）ので、1 つでも busy なら回っている（`busyIn()`）
- 全体で 1 回叩いて 3 秒覚え、返る前に来た呼び出しは走っている 1 本を待つ（#433）
- 詳細の `backgroundOf()`（`--bg` のセッションか）は、前に引いた一覧があれば待たずに `peekBackground()` で返す（#592。引き直しは裏で続く。引けないまま `AGENTS_PEEK_MAX_MS` = 30 秒を過ぎたら「分からない」に戻す）。返信の直前（`launch()`）は今までどおり引き直して待つ
- `claude` が無い・古い・時間切れ・壊れた出力は `undefined`（分からない）で、transcript の判定を使う（`GhPr` と同じ作法）。`SAI_CLAUDE_AGENTS=0` で丸ごと切れる
- Claude だけ

## OpenCode の読んだ量

- `OpencodeServer.context()` が `GET /session/<id>/message?limit=10` の一番新しい、入力が 0 でない返答の `tokens` の `input + cache.read + cache.write` を `shared/progress.ts` の `opencodeContext()` で読む。手順は空のまま
- 立っているサーバにだけ聞き（`todos()` と同じ `live()`）、`ProgressReader` が `OPENCODE_CONTEXT_TTL_MS`（10 秒）覚える（`sai_sessions` は相手の数だけ一度に聞く）
- `createApp` が `progress.useOpencode()` で繋ぐ。これで #311 の予算がそのまま効く

## OpenCode の段取り

- `OpencodeServer.todos()` が `GET /session/<id>/todo` と `/children`
- 応答は `[{"content":"調べる","status":"completed","priority":"medium"}, …]` で `id` は無い（並びがそのまま順番。読み方は `shared/todos.ts` の `opencodeTodos()`）
- `status` は `pending` / `in_progress` / `completed` / `cancelled`。`cancelled` は済みにも残りにも数えない
- `children` は `Session` の配列が返るが、まず数だけ出す（木を描くのは後で。`title` に `math calculation (@general subagent)` のような名前が入る）
- 立っているサーバにだけ聞く（#421 と同じ `live()`）ので、実際に出るのは SAI から返信したセッション
- 中身は `rev` にも混ぜる（同じ rev だと画面が描き直さない）
- 画面は `web/src/ProgressTodos.tsx`

## ターン完了の行が落ちた印（#614）

- 判定は `shared/stopMissing.ts`。`stopMissingCandidate()` が行だけで候補を絞り（Claude・`last_kind === 'resume'`・`last_user_ts === end` = 最後の行が入力の載った入力の行・`STOP_MISSING_AFTER_MS` = 60 秒たっている）、`stopMissing()` が transcript と突き合わせる。
- transcript の側は `ProgressReader.read()` が返す `closed_at`（Claude だけ。ターンの始まりを見ていて・閉じていて（`end_turn`）・手順があるときの、最後の手順の時刻）。**入力の行より後に閉じていて、閉じてから 60 秒たっている**ときだけ印。回っている・Esc で止めた（`[Request interrupted` が次の入力として開く）・途中から読んだ・読めない、は `closed_at` が無いので出ない。
- 載せるのは `sessionsWithMeta()`（一覧・詳細・要対応が同じものを見る）。候補のときだけ transcript を読む（普段は 0 件）。別のマシンのセッションと、SAI が回しているセッション（`mcpBusy()`）は見ない。同じセッション ID のターン完了の行が、その入力より後に**別のエンティティ**（ターンの途中で別の worktree に移った）に載っていれば出さない（transcript はセッション ID で引くため）。時間で出る印なので、出しているセッションの id を rev に混ぜる。
- **行は書かない・補わない**。`turns`・未読・`todoItems()` は触らない（数えるのはターン完了の行だけ、のまま）。

## 落ちた返答を transcript から補う（#614）

- **見つける**のは `shared/recoveredTurns.ts` の `turnGaps()`（行だけで決まる純粋関数）。セッション単位で（エンティティではなく。ターンの途中で別の worktree に移ることがある）、入力の行（`resume` で `user_text` あり）のあと次の入力の行までにターン完了の行が無ければ `missing`、ターン完了の行の本文が空なら `empty`（#613 の、締切に間に合わなかったときの行）。Claude・このマシン・`session_source: payload` の行だけ。
- **読む**のは `shared/claudeTurns.ts`。`turnParser()` / `claudeTurns()` が transcript を人の入力で区切り、そのターンのいちばん新しい本文と、その行が閉じた行（`end_turn` / `stop_sequence`）かを取る（`record.py` の `_turn_assistant_text()` と同じ読み方）。`findTurn()` が入力の行の時刻（±10 秒。複数あれば入力の頭が同じもの）で当てる。入力の行が無い `empty` は、行の時刻の 60 秒前〜5 秒後に終わったターン。**近いものが無ければ当てない**（前のターンの返答を出さない。#467）。
- **取るのは候補のときだけ**（`server/local/recovered.ts` の `RecoveredTurns`）:
  - 最後のターン（あとに行が続いていない）は `ProgressReader.claudeTurns(…, false)` で**末尾だけ**読む。入力から 60 秒・閉じてから 60 秒（`STOP_MISSING_AFTER_MS`）たっていて、SAI が回していない（`mcpBusy()`）ときだけ補う。**読む前に間引く**: 決まらなかった候補は 15 秒（`RETRY_MS`）は読まず、そのあとも `claudeSig()`（stat だけ）で transcript が変わっていなければ読まない（閉じていて 60 秒の待ちが明けるのを待っているだけのときは読む）。末尾に見当たらず頭から読んでも決まらなければ、次に頭から読むのは 5 分後（`FULL_RETRY_MS`）。
  - もう終わった古いターンは `claudeTurns(…, true)` で頭から 1 行ずつ読む（`worthParsing()` でツールの戻りと本文の無い assistant の行は JSON にしない）。**応答は待たせず**裏で 1 本ずつ読み、決まったら次の応答から載る。決まった結果（補えない、も含む）は鍵（`gapKey()`）で覚えるので、同じ候補で読み直さない。立て直すと読み直す。
  - 閉じないまま次の入力が来ていたターン（Esc で止めた）は補わない（途中の地の文を返答にしない）。
- **重ねる**のは `applyRecovered()`: `missing` は入力の行の身元を引き継いだ `Stop` の行（時刻は閉じた時刻、`user_text` は入力の行のもの）を足し、`empty` は本文を載せた写しに差し替える。どちらも `recovered: true`。**JSONL は書かない・書き換えない**。
- **使い分け**: `app.ts` の `rowsNow()`（補った行を重ねたもの）を、人に見せる・返答を引く道が使う（詳細・フィード・ターンの取得・未読・`replyOf()` = 画面の返答 / 次のターンの頭 / `sai_wait`・MCP の `sai_session`）。**集計（`store.sessions()`。`turns`）と一言（`digest.scan()`）は記録の行（`store.rows()`）のまま**。一覧は `sessionsWithMeta()` が補った行で上書きする: `last_text` / `last_turn` / `last_turn_ts` は**最後のターン完了より新しければ**（最後の行とは比べない。端末のセッションは 60 秒あとに `入力待ち` の行が来る）、`end` / `last_kind`（`turn`）は最後の行より新しければ。そのとき前の `waiting` / `idle` は畳む（許可を端末で答えたあとターン完了が落ちたセッションを「待機中」のまま残さない）。重ねた候補の鍵のハッシュを rev に混ぜる。
- 補えたセッションは `stopMissingCandidate()` に当たらなくなる（`last_kind` が `turn`）ので、見出しの「完了の記録なし」は出ない。

## 終わったターンの手順（#605）

- `GET /api/sessions/<id>/turn-steps?ts=`（`app.ts` の `getTurnSteps()`）。**人が開いたときだけ**呼ばれる（`web/src/TurnSteps.tsx`。ポーリングには乗せない）。
- 読むのは `ProgressReader.turnSteps()`: transcript / rollout を頭から 1 行ずつ `shared/turnSteps.ts` の `claudeStepParser()` / `codexStepParser()` に流す。ツールの戻りの行は JSON にしない（`skipForSteps()`）。結果は (mtime, size) が同じ間、直近 4 ファイルぶんだけ覚える。
- ターンの切り方: Claude は人の入力（メタ・要約・ツールの戻り・サブエージェントでない user の行）から次の人の入力まで、Codex は `task_started` から。手順は `tool_use` / `function_call` / `custom_tool_call` だけ（考えた・書いたは入れない）。
- 要約は許可のバブルと同じ `toolSummary()`（Claude）。Bash の `description` は `note` に分ける（`summary` はコマンドそのもの）。Codex は `codexToolText()`（`codexToolSummary()` の 1 行に切る前）。どちらも 300 字で切る。**出力は読まない**。
- 行との引き当ては `findStepTurn()`: 「終わり」は行の `ts` の 20 秒前〜5 秒後に終わった一番新しいターン。「始まり」は、前のターン完了の行より後の入力の行を古い順に試し、transcript に近いターン（±10 秒。複数あれば入力の頭が同じ方）がある最初のもの（Esc ですぐ止めた入力は transcript に残らないことがある）。**始まりから終わりまでをつないで返す**（ターンの途中で入力が足される = steer・タスクの通知と、transcript では 2 つに切れる）。間に Esc で止めた跡（`[Request interrupted`）があればその後ろから。始まりだけ見つかればそのターン、始まりが 1 つも無ければ（自分で起きた・Codex）終わりだけで当て、どちらも無ければ当てない。
- 引けない・別のマシン・OpenCode は `found: false`（画面は「記録がありません」）。行（JSONL）には何も足さない。

## 画面

- 処理中のセッションを出している間だけ `web/src/useProgress.ts` が 3 秒おきに取る（一覧のポーリングには乗せない）
- `ProgressSteps` が仮バブルの「処理中 N分」の横にいまの手順を 1 行、押すと直近の手順を出す。送った時刻より前に始まった手順は `stepsSince()` で落とす（新しい入力が transcript に届く前は、最後のターンが前のターンのままなので）
- セッション画面は、`replying` が無くても、行の上で最後が人の入力（`web/src/openPrompt.ts` の `openPromptSince()`）かつ `active` なら「処理中」を出す（端末で打ったターン）
- フィードは `FeedPendingBubble` がバブルごとに取る（端末で打ったターンはフィードには出さない）

## 端末の Claude の質問の選択肢

- `claudeProgress()` が今のターンで `tool_result` の付いていない一番新しい `AskUserQuestion` を `ParsedProgress.question`（`PendingQuestion`: `input` そのまま・`asked_at`・`text` = `approvalText()`）に持つ（答え・人の入力で消す）
- `app.ts` の `pendingQuestion()` が詳細の応答の `question` に載せる。載せるのは `session.waiting` がその `text` と同じときだけで、Claude・このマシン・SAI が回している `claude -p` でないときに限る
- `question.asked_at` を詳細の rev に混ぜる（transcript と待ちの行の書かれる順が前後するので）
- 画面は `Chat` が `web/src/terminalQuestion.ts` の `questionsFor()`（同じ文の、まだ解消していない待ちのバブルだけ。`terminalQuestion.test.ts`）で選び、`Message` の待ちのバブルの下に `QuestionPreview` を読むだけで出す
- まだセッション画面だけ（フィード・要対応は出さない）。行に選択肢を載せる案は #334（行から出す分は CLAUDE.md の record.py の項）
