# セッション同士のメッセージと MCPの仕組み

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/agents.md](../history/agents.md)。

画面から見た動き・送れる相手・回数と予算の数字は [screen.md](../screen.md) の「セッション同士のメッセージ（#310）」、口の形は [api.md](../api.md)、tailnet から呼ぶ手順・ツールの表・grants の例は [tailnet.md](../tailnet.md)。ここにはコードの側の話を置く。

## セッション同士のメッセージ

### ツールと口

- SAI が起動した `claude -p` の MCP サーバ（`server/approvals/approve-mcp.ts`）が、承認の `approve` に加えて `sai_sessions` / `sai_send` / `sai_wait` を出す。出すのは `SAI_TOKEN_FILE` を渡されたときだけ（叩いても断られるツールを見せない）。
- ツールはエージェント用の口 `GET /api/agent/sessions`・`POST /api/agent/send`・`GET /api/agent/wait` を叩く（中身は `agentTool()`）。
- 鍵は `~/.agent-feed/agent-token`（`server/reply/agentMessages.ts` の `ensureAgentToken()`。0600）の中身で、`X-SAI-Agent-Token` で送る。MCP サーバには中身ではなく場所を渡す。

### 送り元と送り先

- 送り元は、SAI が起動していまターンを回しているセッションだけ（`run.snapshot()` にあって `failed` でない。MCP の `SAI_ENTITY`）。
- 送り先は `shared/agentMessages.ts` の `agentTargets()`（同じ `project`・自分以外・アーカイブ済みでない・`replyBlockedReason()` が空）。

### 同じファイルを触っているか（#564）

- エージェント用の `sai_sessions`（`GET /api/agent/sessions`）の 1 件（`AgentSessionEntry`）に `overlap` / `overlap_more` を載せる。**呼んだセッションの worktree と相手の worktree のどちらでも変わっているファイル**で、組み立ては `shared/agentMessages.ts` の `agentOverlap()`（パスの順に先頭 `AGENT_OVERLAP_SHOW`＝5 件と残りの数）。
- 「変わっているファイル」は差分ビューアと同じ範囲（`base...HEAD` + 未コミット + 追跡外）で、`server/git/diff.ts` の `changedPaths()` が `--numstat` だけを読む（本文は作らない。`RealGit` の読むだけの allowlist の中）。**cwd は行から取り**、リクエストからは受けない。別のマシンのセッションは空。**`gh` で PR の files は引かない**（外へ問い合わせる場所を増やさない）。
- パスはどれも**リポジトリのトップからの形**（追跡外は `--full-name`。サブディレクトリで開いたセッションでも `diff` と揃う）、**リネームは `--no-renames` で消した・足した 2 つのパス**にする（`{old => new}` の形では相手の編集と突き合わない）。
- 数えないもの: `CLAUDE.md` / `README.md`（どの階層でも）/ `docs/`（`overlapIgnored()`。ほぼ全部の PR が触る）、同じ worktree の相手（**cwd ではなく `rev-parse --show-toplevel` で比べる**。サブディレクトリで開いたセッションを別の worktree と取り違えると、差分が全部「重なり」になる）。`main` にいる worktree は差分が無いので自然に空になる。
- **ツールが呼ばれたときだけ**計算し（ポーリングには乗せない）、`app.ts` の `changedOf()` が `(cwd, last_turn_ts)` で `CHANGED_PATHS_TTL_MS`（30 秒）覚える。時間でも切るのは、呼んだ側はターンの途中で編集していて `last_turn_ts` が変わらないため。
- **知らせるだけで、自動では送らない**。送るかはエージェントが決める（ツールの説明に「使う場面・使わない場面」を先に書いてある。`approve-mcp.ts` の `AGENT_TOOLS`）。MCP の `sai_sessions`（`/mcp`。Manager・tailnet 用）には出さない（呼び出し元に「自分の worktree」が無い）。

### いま何を持っているか（#727 の案 D の読む側）

- `sai_sessions` の 2 つの口（SAI が渡す `sai` = `GET /api/agent/sessions` と、tailnet の `/mcp`）の 1 行に、そのセッションが**いま持っているもの**を足す。組み立ては `shared/holding.ts`（純粋関数）で、`app.ts` の `holdingsOf()` が材料を集める。**SAI は持ち場を書いて持たない**（登録する口は無い）。機械で引けたものだけで、引けなければ付けない。
- `pr`: そのセッションのブランチ（`SessionSummary.branch`）から出ている open な PR の番号と CI（`PrSummary.checks`）・下書きか（`prOfBranch()`。fork の同じ名前のブランチは結ばない）。リポジトリは記録の `remote`（`githubRepoOf()`）で、別のマシンのセッションと remote の無いセッションでは引かない。読むのは今ある `gh pr list` の決まった形（`PrBrowser`）だけ。
- **応答を `gh` に待たせない**: `PrBrowser.cached()` が前に引いた一覧をそのまま返し、古ければ（`PRS_CACHE_MS`）裏で引き直す。まだ 1 回も引いていないリポジトリだけ `HOLDING_PR_WAIT_MS`（1.5 秒）待ち、間に合わなければ PR の印を付けずに返す（行は落とさない）。同じリポジトリは 1 回の呼び出しで 1 回しか聞かない。`SAI_GH=0` では引かない。
- `issues`: `issueNumbers()` が、ブランチ名の `issue-<番号>`・PR の題名の `#<番号>`（その PR 自身の番号は除く）・届いていてまだ返していない依頼の **1 行目**の `#<番号>` から引く（`HOLDING_ISSUES_MAX` = 3 件まで）。本文の途中の番号は拾わない。
- `asked`: 別のセッションから頼まれて、まだ返していないメッセージの数。`AgentMessages.sentTo()` の `HOLDING_ASK_DAYS`（2 日）以内のもののうち、返答（そのメッセージで回ったターンの完了の行。見出しの id）がまだ無いものと、まだ送っていない預かり（`heldFor()`）。行は 1 回だけ舐める。
- `free`: 処理中でない・待ち（許可・質問・入力。端末で答えたぶんは畳む）が無い・預かりが無い・`asked` が無い。
- 1 行の印は `holdingLabel()`: `（空き） PR #728（CI 緑） issue #727 頼まれ中 1 件`。題名・本文は載せない（#688）。増える字数は 1 行あたり 0〜56 字（空きだけなら 5 字、PR と issue が 1 つずつで 25 字、空き + PR + issue で 31 字。下書きの 5 桁の PR・issue 3 つ・頼まれ中が全部付いて 56 字）。
- エージェント用の応答では `AgentSessionEntry.holding`（何も分からなければ省略）。

### 送る・待つ

- 送るときは `deliveredText()` の見出し（`【SAI】#<project> の「<呼び名>」からのメッセージです（id: <message_id>）…`）を付けて、`launch()` に `queue: true` と `origin: message_id` で渡す。処理中なら #305 の預かりに並び、`StoredReply.origin` として持ち越す。
- `sai_wait` は `replyOf()` が見出しの id の入った相手のターン完了の行を探し、`clipReply()` で切って返す。相手の `Replying.failed` か、預かりの先頭のまま止まったら `failed`。
- **ターン完了の行の `user_text` が自動の要約の文に置き換わっていたら（#626）、同じセッションの直前の入力した瞬間の行（`UserPromptSubmit`）の見出しで当てる**（`deliveryMatcher()`。`replyOf()` と `agentReplyRows()` が同じものを使うので、行は古い順に渡す）。救うのは `user_text` が要約の行だけで、入力の行の見出しは次のターン完了の 1 つにだけ使う（入力が空のターン・人が打ったターンには当てない）。`入力待ち`・セッションの終了の行が来たら見出しを捨てる（届けたターンのターン完了の行が落ちたまま、あとの関係の無いターンに当てない）。入力の行を覚える・捨てる規則そのものは `shared/turnPrompts.ts` の `promptTracker()` にあり、記録を調べる道具の `pairTurns()`（#703）と同じものを使う。
- 待つのはサーバ側（`wait=1` で `WAIT_MS`、MCP サーバが最長 30 分繰り返す）。
- 受け取った側の目印は見出しそのもの（画面は触っていない）。
- 見出しの「返答はどこへ行くか」は `REPLY_NOTE`（「このターンの最後の発言が返答として送り元の画面に出ます（送り元が sai_wait で待っていれば、そのまま受け取ります）」）。送り元が待たないこともあるので「送り元に返ります」とは言い切らない（#588）。

### 送り元の画面に返答を出す（#588）

- 送り元が `sai_wait` せずにターンを終えても、相手の返答を**送り元のセッション画面**に並べる。詳細の応答の `agent_replies` に、`shared/agentMessages.ts` の `agentReplyRows()` が作った行（相手のターン完了の行に `agent_reply`＝`message_id` / `to_name` / `sent_at` を付けたもの）を載せる。
- 行は 1 回だけ舐め、見出しの id（`deliveredId()`）で引き当てる（メッセージごとに `replyOf()` を呼ぶと 3 秒のポーリングのたびに 送った数 × 行 になる）。相手が違う行（見出しを写しただけ）は数えず、1 つのメッセージに 1 本（最初のターン完了）。描いている窓（`recent`）より前の返答は載せない。返答の id を詳細の `rev` に混ぜる。
- 呼び名は `replierName()`（表示名 → 題名。受け取った側の題名は届けた見出しそのものになっているので、そのときは worktree 名）。
- 画面は `SessionView` が `web/src/agentReplies.ts` の `withAgentReplies()` で時刻の順に混ぜて `Chat` に渡す。`toUtterances()` は `agent_reply` の行を相手のバブル 1 つにし（届いた文を自分のバブルにしない）、見出しに相手の呼び名と「送ったメッセージへの返答」（相手のセッションへのリンク）を出す。**このセッションの未読には数えず**（`firstUnreadKey()`）、「ここから未読にする」も出さない。
- 送り元の記録（JSONL）には書かない（SAI は行を起こさない）。フィードと要対応の未読の段には出さない（決まっていない）。

### 返答のバブルから、その場で相手へ返信する（#700）

- 送るのは**人**で、口は画面の返信（`POST /api/sessions/<相手>/reply`）のまま。`ReplyRequest.sent_from`（`{ id: 送り元, anchor: どのバブルの下か = その行の ts }`）を添えるだけで、送り方（端末・別プロセス・預かり）は変わらない。`sai_send` は通さないので、送り元のターンは起こさず、返答を送り元の会話にも渡さない（`handed_at` は付かない）。
- サーバは受け付けた（`202`）あとに `AgentMessages.follow()` で覚える（`server/reply/agentMessages.ts`。`agent-messages.json` の `followups`。`AGENT_FOLLOWUPS_KEEP` = 200 件、本文は 500 字まで）。**覚えるのは、送り元がその相手にメッセージを送ったことがあるときだけ**（返答のバブルが出うる組）。そうでない `sent_from` は黙って捨て、返信そのものは届く。`anchor` は表示にしか使わない。
- 送り元の詳細の応答に 3 つ載せる: `agent_followups`（バブルの下の 1 行。`AgentFollowupLine`。本文は `followupHead()` で 1 行目の頭 40 字）、`agent_replies` に混ぜる相手の返答（`agent_reply.followup: true`）、`agent_reply_sessions`（返答の相手の `SessionSummary`。セッション画面は一覧を持たないので、入力欄・`replyBlockedReason()`・相手の `next_ask`・行数（`turns`）はここから取る。一覧の窓の外の相手は載らず、そのときは返信の口を出さない）。
- 相手の返答の引き当ては `shared/agentMessages.ts` の `followupReplyRows()`。見出しの id が無いので、**相手のセッションの、送ったあとのターン完了の行のうち、入力（`deliveryMatcher().headOf()`）の頭 `FOLLOWUP_MATCH_CHARS`（200 字）が送った文と同じ最初の 1 つ**を当てる（SAI が頭に足した返答の塊 #594 は `splitHandedReplies()` で外してから比べる）。預かりに並ぶと間に別のターンが終わるので「次のターン完了」では当てない。1 つの行は 1 つの返信にだけ（同じ文を 2 回送ったら古い順に 1 つずつ）。**入力が記録に無いターン（入力の行を書かないエージェント・要約で入力が置き換わった行・スキルの展開で入力が変わる場合）には当たらず、そのときは 1 行だけが残る**（返答は相手のセッションで読む）。
- 画面は `web/src/replyAcross.ts` の `replyFooter()`（純粋関数）が、バブルごとに「出す行・返信できるか・1 押しの案」を決め、`AgentReplyFooter` が描く。`Chat` は `renderReplyFooter` を返答のバブルの下に呼ぶだけ（フィードには渡さない）。入力欄は要対応と同じ `TodoReplyBox`（中身は `ReplyBox`。`key` と打ちかけは相手の ID）で、送るのは `SessionView` の 1 つの `useReply`（相手の行数は `agent_reply_sessions` の `turns`）。確認（端末の打ちかけ）から送り直すときも `sent_from` を付け直す（`ReplaceConfirm.sentFrom`）。送り直して空にする入力欄は返信先ごとに数える（`useReply` の `confirmedSentBy`。全体の数で見ると、相手への送り直しで送り元自身の打ちかけが消える）。相手への送り直しが受け付けられたら入力欄を閉じ、戻してあった相手の打ちかけは `SessionView` が直接消す（閉じた `ReplyBox` は増えた数を見ないまま外れるため）。
- 1 押しの案は**相手の** `next_ask` で、相手の最新のターン（`last_turn_ts`）のバブルにだけ、相手が処理中でも預かりが残ってもいないときだけ出す。押したら `reportDigestUsage(…, 'next_ask_accepted')` を残す。
- 確認・失敗を拾うのは、この画面から送った相手のぶんだけ（`Across.sentTo`。ほかの画面から送った返信の失敗は拾わない）。失敗の案内は最後に送ったバブルの下にだけ出す。送った直後は、サーバの行が届くまで手元の 1 行（`JustSent`）で繋ぐ。届いたかは**そのバブルの下の行の数**（`known` より増えたか）で見て、時計では比べない（`withJustSent()`）。
- `App` の入力欄へのフォーカス（`applyFocus()`）は `.reply-footer` の中の入力欄を飛ばす（そのセッション自身の入力欄に当てる）。

### 返答を送り元の会話に戻す（#594）

- **送り元の次のターンの頭に、まだ渡していない返答を足す**（既定。ターンは増えない）。`launch()` が `startTurn()` の直前に `pendingRepliesOf(id)` を呼び、`shared/agentMessages.ts` の `withHandedReplies()` で本文の頭に塊を付ける。塊は `HANDED_MARK`（`【SAI 返答】`）で始まり `HANDED_END` で終わる。**`【SAI】` では始めない**（`deliveredId()` が届けた見出しと取り違えないため。id も `message_id: …` と書き、`（id: …）` の形にしない）。
- 足すのは、送ってから `HANDED_KEEP_DAYS`（7 日）以内で、相手のターンが終わった（`agentResult()` が `done`）か失敗した（`failed`。1 行で知らせる）もので、まだ返っていない依頼は足さない。古い順に `HANDED_MAX_ITEMS`（8 件）・本文の合計 `HANDED_MAX_CHARS`（12,000 字）まで本文を載せ、入りきらない分は名前と id だけの 1 行にする。1 件は `clipReply()`（4,000 字）のまま。
- 起動できたとき（`202`）だけ `AgentMessages.handed()` で `AgentMessage.handed_at` を付け、`agent-messages.json` に残す（立て直しても 2 回は足さない）。**`sai_wait` で受け取ったもの（エージェント用の口と `/mcp` の両方）も渡した扱い**にする。
- 足す経路は SAI が送り元のターンを起こすものすべて（人の返信・預かりが回る・端末への打ち込み）。**要約だけのターン（#579）には足さない**（`/compact` の本文には付けず、預かりの本文を回すときに足す）。**端末で直接続けたターンには足せない**ので、未渡しのまま残し、次に SAI から回したときに渡す。
- **足さない場面**: 別のセッションから届いたメッセージで起こすターン（`o.origin`。見出し `【SAI】…` が頭に無いと `deliveredId()` / `replyOf()` が当たらず、送り元が返答を引き当てられない）と、`/`・`$` で始まる指示（スキル・コマンドは頭に無いと CLI が展開しない）。どちらも未渡しのまま残り、次のふつうのターンで渡る。
- **足したターンが失敗したら「渡した」を取り消す**（`AgentMessages.unhand()`）: `launch()` が `handedTurns` に覚え、`replyingOf()` がそのターンの `failed` を見たら取り消す（エージェントは読んでいないので、次のターンでもう一度足す）。覚えはメモリだけ（立て直しをまたいだ失敗は渡した扱いのまま）。
- **応答の `replying[].text` からは塊を外す**（`replyingOf()`）。入力欄への戻し（`useReply`）・一覧の 2 行目（`sessionPreview()`）・↑ の履歴の `extra` がこの文を使うため。`promptArrived()` は記録の `user_text` の側も外して比べる。
- 記録の `user_text` には塊ごと残る（SAI は行を書き換えない）。画面は `splitHandedReplies()` で塊を外して見せる: 自分のバブル（`chatGroups.ts` の `Utterance.handedReplies` →「返答 N 件を添えました」）・仮バブル（`PendingBubble`）・題名と最後の入力（`aggregate.ts`）・↑ の履歴（`replyHistory.ts`）。
- 返答のバブルの見出しには、送り元の会話に渡したか（`AgentReplyTag.handed_at`）を「会話に渡した / 次のターンで渡す」で出す。
- 見出しの `REPLY_NOTE` と `sai_send` / `sai_wait` の説明（`approve-mcp.ts` の `AGENT_TOOLS`）は「待たずに終えてよい・返答は次のターンの頭に届く・`sai_wait` はその場で答えが要る短い質問だけ」に合わせた。
- **送り元がまだ回っていれば、その場で足す**（#594 の 2）: `app.ts` の `deliverReplies()` が、入力の口（#386 の stream-json）が開いている送り元（`run.snapshot()[from].interruptible`。要約だけのターンは除く）に、返答の塊＋`STEERED_NOTE` を `run.steer()` で書く。足せたら「渡した」にする（次のターンには重ねない）。読み直しは増えない。呼ぶのは相手のターンが終わったとき（`-p` の `onExit`・Codex の `onTurnEnd`）と、画面のポーリングのついで（`drainAll()`）。
- **「返答が来たら起こす」**（#594 の 3。`sai_send` の `wake` → `AgentSendRequest.wake` → `AgentMessage.wake` / `turn` / `url`）: 同じ送り元・同じターンで `wake` を付けたもの（`AgentMessages.wakeGroups()`）が**全部返った（か失敗した）**ら、`deliverReplies()` が送り元のターンを **1 回だけ**起こす（本文は返答の塊＋`WAKE_NOTE`。ほかの未渡しの返答も一緒に渡す）。
  - 起こすのは `launch(from, …, { queue: true, origin })` で、**メッセージで起こしたターンと同じ扱い**にする: 起こしたターンからは送れない（連鎖 1 段。#311）、送り元が処理中なら預かりに並ぶ、人が「送信を止める」を押せば預かりからも取り消される。
  - 起こさない場面: 送ったターンがまだ回っている（上の「その場で足す」に任せる）・人が「送信を止める」にしている・送り元のエージェントの使用量の枠が残り少ない（`usageRefusal()`）・一度起こせなかった組（ポーリングのたびに繰り返さない）。起こさなかった分は未渡しのまま残り、次に SAI から回るターンの頭で渡る。理由は reply.log に 1 回だけ残す。
  - `/mcp`（tailnet）の `sai_send` には `wake` を出さない（送り元がセッションではない）。
- **「渡した」にする時点**（#607 のレビュー）: その場で足した分は、そのターンが失敗したら取り消す（`rememberHanded()` → `replyingOf()`）。**`sai_wait` で待っている返答は入力の口からは足さない**（`waitedAt`。その応答で渡るので、両方から渡すと同じターンで 2 回読ませる）。**預かりに並んだ「起こす」は、回るまで渡した扱いにしない**（`wakeQueued`。人が取り消す・「送信を止める」で消えたら未渡しのまま残し、もう起こさない）。
- `STEERED_NOTE` / `WAKE_NOTE` だけの入力は人の入力ではないので、題名・一覧の「最後の入力」（`aggregate.ts`）・↑ の履歴には使わない（`isHandedOnly()`）。

### トークンの歯止め（#311）

- 回数: `AgentMessages` が 1 ターン（送り元の `Replying.since`）に `AGENT_SEND_MAX`（3）回まで数える。**その場で送れるのがこの回数まで**で、超えた分は断らずに預かる（下の「上限を超えた送信を預かる」）。
- 連鎖: `launch()` がメッセージで起動したターンを `agents.launched(id, origin)` で覚えて、そこからは送らせない（連鎖 1 段。人の返信で起動し直すと忘れる）。
- 使用量: `usageRefusal()` が相手のエージェントの枠（`UsageStore.get()`。5 時間 `AGENT_USAGE_STOP_PERCENT` = 80%、週 `AGENT_WEEKLY_STOP_PERCENT` = 95%、Claude の `limited`）を見て `429`。戻った枠と取れない使用量では止めない。
- 読み直させる量の予算 `AGENT_TURN_READ_BUDGET`（300 万トークン）:
  - 相手の大きさは `ProgressReader.read()` の `context_tokens`。`shared/progress.ts` が transcript の assistant の `usage` の入力 3 つの和 / rollout の `token_count` の `last_token_usage.input_tokens` を拾う（`total_token_usage` は積算なので使わない）。
  - `AgentMessages.readInTurn()` に足していき、`budgetRefusal()` が超えるなら `429`。大きさが分からない相手は足さない。
  - `sai_sessions` と `sai_send` の返事にも出す（エージェントが小さい相手を選べるように）。
- テストは `createApp` に偽の `UsageStore` / `ProgressReader` を渡す（本物は ~/.claude と ~/.codex を読む）。
- **宛先は id か呼び名**（#625）: `shared/agentMessages.ts` の `resolveTarget(targets, to)` が、id がそのまま当たればそれ、当たらなければ `targetNames()`（id・表示名・worktree 名 `repo`・`sessionLabel()`。前後の空白と大文字小文字だけ無視）の完全一致で探し、**ちょうど 1 つのときだけ**返す。引く範囲は今までどおり `agentTargets()` の中だけ。**送れないが居るセッション（素通し・別のマシンなど。アーカイブ済みは除く）に同じ名前があれば、送れる方が 1 つでも当てない**（第 3 引数 `blocked`。送れる相手だけで数えると、指していた方が送れないときに別の相手へ黙って届く。#662 のレビュー）。決まらなければ `targetRefusal()` が候補を並べた文を返す（複数 `409`・無し `403`）。`/mcp` の `sai_send` / `sai_suggest` は `mcpTarget()`（id は今までどおり全セッションから、名前は送れる・置ける相手の中からだけ。無いときに全リポジトリの一覧は並べない）。宛先の説明は `SEND_TO_ARG`。
- **着手の依頼は要約してから始める**（#624）: `agentSend` と `/mcp` の `sai_send` が `messageCompactOf()` → `shared/compact.ts` の `messageCompacts()`（画面と同じ `sendModes()`。指定 `AgentSendRequest.compact` があれば指定、ただし `canCompact()` でなければ要約しない）で決め、`launch()` に `compact` と `compactFrom`（**見出しを付ける前の文**。`compactPrompt()` はここから作る）を渡す。
  - 相手の大きさは予算の検査で読んだ `context_tokens` をそのまま使う（読み直しは増やさない）。予算に足す量も今のまま（要約の前の大きさ）。
  - 本文（見出し付き）は `launch()` が預かりの先頭に `origin` 付きで置くので、要約のあとに回る本文のターンも「メッセージで起動したターン」のままで、返答は `replyOf()` で引き当たる。要約が失敗すれば預かりが止まり、送り元には `failed` が返る（`agentResult()` の「預かりの先頭のまま止まった」）。
  - 相手が処理中・預かりが残っているときは `launch()` が今までどおり預かりに並べる（要約は挟まない）。
  - 返事の文は `shared/agentMessages.ts` の `sendHow()`、ツールの説明に足す文は `SEND_COMPACT_NOTE` / `SEND_COMPACT_ARG`（セッション同士の口と `/mcp` で同じ文）。

### 上限を超えた送信を預かる（#727）

- `POST /api/agent/send` は、1 ターンの回数（`AGENT_SEND_MAX`）か 1 ターンの読み直しの予算（`AGENT_TURN_READ_BUDGET`）を超える送信を `429` にせず**預かる**（応答は `202` で `held: true`。`message_id` は預かるときに決める）。預かりが残っている間は、あとから来た送信も後ろに並べる（追い越さない）。同じ送り元からの送信は 1 つずつ通す（`sendLocks`。ツールを並べて呼ばれても、どれも「まだ 0 回」を見ない）。**1 件だけで 1 ターンの予算を超える相手**は、預かっても 1 巡で送れないので今までどおり `429`。空の `items` は付いていないのと同じ。
- **預かる前に数える**: 宛先を全部引き当て、相手の使用量の枠と読み直す量（`progress.read().context_tokens`）を見てから、`requestRefusal()`（`shared/agentMessages.ts`）が依頼 1 つの上限を見る。依頼＝送り元のそのターンで頼んだ分（もう送った分 + 預かっている分 + 今回）で、上限は **`AGENT_REQUEST_MAX`（8 件）と `AGENT_REQUEST_READ_BUDGET`（600 万トークン）**。超えるなら 1 件も送らず・預からずに `429`（宛先ごとの量を理由に書く）。**仮の値で、変えるならこの 2 つの定数**（と巡の間 `AGENT_BACKLOG_ROUND_MS`）。
- 複数の宛先を 1 つの依頼として渡す形（body の `items: [{ to, text, compact? }]`。ツールでは `sai_send` の `items`）は、同じ道を通る: 全部を確かめてから、上から順にその場で送れる分を送り、残りを預かる。応答は `AgentSendManyResponse`（1 件ずつ `via` / `held` / `error`）。
- 人が止めている・受け取ったメッセージで回っているターン（連鎖）からは、預かりもしない（`AgentMessages.refusal(from, turn, Infinity)`。回数だけを見ない）。
- 送るのは `drainBacklog()`（`server/app.ts`）: **送り元のターンが終わってから**（`run.running(from)` の間は送らない）、1 巡に `AGENT_SEND_MAX` 件・`AGENT_TURN_READ_BUDGET` まで、巡と巡の間は `AGENT_BACKLOG_ROUND_MS`（60 秒）空ける。呼ばれるのはターンの終わり・画面のポーリング（`drainAll()`）・前の巡が掛けたタイマー（`unref()`）。送り方は `sai_send` と同じ `launch()`（相手が処理中なら相手の預かりに並ぶ。権限のフラグは足さない）で、送れたらいつもの記録に載る（`recordHeld()`。返答は送り元の画面と次のターンの頭に届く。1 ターンの回数・量 `sends` には足さない＝送り元がいま回している別のターンの数を潰さない）。巡の途中で呼ばれたら終わったあとにもう 1 回見る（`backlogAgain`）。立て直したあとは `BACKLOG_STARTUP_MS`（5 秒）後に、前のサーバが残した預かりを見始める。
- 送る直前にもう一度確かめる: 相手がまだ送ってよい相手か・相手の使用量の枠・相手が 1 件で 1 巡の予算を超えていないか。通らない 1 件・起動できなかった 1 件・途中で例外になった 1 件は、**捨てずに理由を付けて止める**（`haltHeld()`。エージェントには「預かった」と返してあるので黙って消さない。画面に「送っていません」と出て、`reply.log` にも残る）。止まった分は自動では送らず、人が「送信を止める」で捨てる。
- 置き場は `AgentMessages` の `backlog`（メモリと `agent-messages.json`）。**送る前に送りかけの印を書く**（`beginHeld()`）。印が付いたまま立て直されたものは、届いたか分からないので送り直さず、理由（`HALTED_ON_RESTART`）を付けて残す（画面に「送っていません」と出る。人が「送信を止める」で捨てる）。記録の済んだ預かりは読み込むときに捨てる。順番待ちの預かりはそのまま残り、立て直したあとの最初の巡で送る。
- 「返答が来たら起こす」（`wake`）は、同じ依頼の `wake` 付きの預かりが残っている間は起こさない（送り切って、その返答がそろってから 1 回）。
- 画面: 詳細の `agent.held`（`AgentHeldMessage`。古い順＝送る順）を `AgentActivityBar` が「預かり（N 番目に送ります）」で出し、見出しに「預かり N 件」を足す。**止める口は今までどおり「送信を止める」**（`POST /api/sessions/<id>/agent/stop`）で、預かりを全部捨てる（`dropHeldBy()`。応答の `cancelled` に数える）。
- tailnet の `/mcp` の `sai_send` は変えていない（回数は `McpSendLimiter` のまま、超えたら断る）。

### 記録

- `agent-messages.json`（`AGENT_MESSAGES_FILE`）に書き、立て直しても残る（#440）。中身は送った記録・止めたこと・1 ターンの回数と量・連鎖の印。

### 人が止める（#311）

- `SessionView` のチャットの末尾の `AgentActivityBar`。出すのは詳細の応答の `agent`（`agentActivityOf()`）があるとき＝送ったことがあるか止めているセッションだけ。いま回しているターンの往復数・読み直させた量と、直近 5 件の送り先（`AgentMessages.sentBy()`。状態は `agentResult()`）を出す。
- 「送信を止める」は `POST /api/sessions/<id>/agent/stop`（同一オリジン）。`AgentMessages.stop()` により `refusal()` が真っ先に断り、`ReplyQueueStore.removeWhere()` がそのセッションから送られて預かりに並んでいた分（`StoredReply.origin` のメッセージの送り元で見る）を取り消す。相手でもう回っているターンは止めない。
- 送った・止めた・再開したは `agents.key()` を詳細の rev に混ぜる。
- 端末のセッションから送る・Codex / OpenCode から送る、は次（#310）。

## tailnet から MCP で呼ぶ口

### 口とツール

- `POST /mcp`。Streamable HTTP の最小で JSON を 1 回返すだけ。
- JSON-RPC は `server/mcp/protocol.ts` の `handleRpc()`（`initialize` / `ping` / `tools/list` / `tools/call`）、ツールの中身は `app.ts` の `mcpTools()`（`sai_sessions` / `sai_session` / `sai_progress` が読む、`sai_suggest` が案を置く、`sai_send` / `sai_wait` が送る・待つ）。
- `sai_sessions` の 1 行には、待ちと最後の記録の時刻も載せる（#323）。待ちは画面と同じく、端末で人が答えたぶんは `settleWaiting()` で畳み、返信中の答え待ちの承認 `approvalsNow()` も足す（1 行目だけ）。

### 誰に何を許すか

- tailnet の ACL（grants）で決める。`server/mcp/access.ts` の `mcpAccess()` が `tailscale whois` の最上段の `CapMap` にある `MCP_CAP`（`github.com/naturalclar/sai/cap/mcp`）の `tools` / `origins` を読む。Serve の `Tailscale-App-Capabilities` ヘッダは見ない（identity と同じく whois で引き直した値だけ）。
- ループバックと tailnet のユーザーは `read` と `draft` が既定、`send` は capability、タグ付きの端末は capability だけ（無ければ 403）。
- `Origin` は無ければ（CLI）通し、あれば capability の `origins` に書いたものだけ。CORS もそれにだけ返す。

### 送る

- #310 の口に乗せる: 見出しは `deliveredFromTailnet()`（`isDeliveryOf()` / `replyOf()` がそのまま返答を探せる形）、`launch()` に `queue: true` と `origin`（受け取ったターンから先へ送らせない）、返答は `agentResult()`。
- 回数は `server/mcp/sendLimit.ts` の `McpSendLimiter`（呼んだ人ごとに 10 分 5 回。`mcp-sends.json` に残る）。
- 使用量の枠（`usageRefusal()`）と読み直させる量の予算（`budgetRefusal()`）は #311 の口と同じものを見る。予算の「1 ターン」の代わりは `McpSendLimiter.windowKey()`（10 分の区切り）で、`AgentMessages.record()` / `readInTurn()` にその鍵で載せる。
- 許可を聞かないモード（`bypassPermissions` / `auto`。判定は `modeSkipsRules()`）のセッションには送らない（`mcpSendRefusal()`。断りの文にモードの名前を出す）。
- `sai_wait` は最大 120 秒で返し、まだならもう一度呼ばせる。
- 返答を引く行は `rowsNow()`（#614。ターン完了の行が落ちた・本文が空だったターンは、transcript から補った行が返答になる。→ [progress.md](progress.md#落ちた返答を-transcript-から補う614)）。
- 送り元は `mcp:<ログイン名>` として記録し、本人だけが待てる。

### 案を置く（`sai_suggest`。#565）

- 範囲は `draft`。**`launch()` も預かりも通らない**（ターンを起こさない）。`server/mcp/suggestions.ts` の `SuggestionStore` が `<feed dir>/suggestions.json` に宛先ごとに 1 つ置き（上書き）、`reply.log` に 1 行残す。
- 断るのはアーカイブ済みと `replyBlockedReason()` が理由を返すもの（入力欄が出ない）だけ。**別のリポジトリ・素通しのセッションにも置ける**（`mcpSendRefusal()` は使わない。送るのは人）。本文は `AGENT_TEXT_MAX_CHARS` まで。
- 出すかどうかは `shared/managerDraft.ts` の `liveManagerDraft()`: 置いてから `MANAGER_DRAFT_TTL_MS`（24 時間）以内で、置いた時刻より後のそのセッションの行に、人の入力が無いもの（`inputSinceDraft()`: 入力の行＝`resume` で `user_text` のあるものが 1 本でも来たら、ターン完了の行は `user_text` のあるものだけ数え、1 本・置いたときにターンが回っていたら＝`busy` 2 本で「来た」。自分で起きたターン（`<task-notification>`）は `record.py` の `last_user_text()` が空にするので数えない）。行は `sessionsWithMeta()` の窓のものを使い、窓が 1 日なら 2 日ぶん読み直す（24 時間は日付を 2 つまたぐ）。`sessionsWithMeta()` が `manager_draft` に載せ、**いま出している案の (id, at) を rev に混ぜる**（ファイルの (mtime, size) だと 24 時間が過ぎて消えたときに rev が変わらない）。ファイルから物理的に消すのは、捨てる・入れた（`take()`）と、次に置いたとき（`put()` が 24 時間を過ぎたものと 500 件を超えたものを捨てる）。
- 捨てる・入れたは `POST /api/sessions/<id>/suggestion`（同一オリジンのみ）。`at` が今のものと同じときだけ取り除く（画面が古い案を見ている間に置き直された新しい案を消さない）。
- 画面は `web/src/replySuggest.ts` の `suggestionFor()` が出どころを決め（打ちかけ > `manager` > `next`）、`ReplyBox` が `ManagerDraftCard` を入力欄の上に出す。入れた・捨てたものは次のポーリングで消えるまで `ReplyBox` の中で伏せる。
- `sai_sessions` の 1 行には `（案を置いてある）` を付ける（Manager が置き直すかを人に聞けるように）。

### 中継（`feed/mcp/sai-mcp.mjs`）

- 呼ぶ側のマシンに置く stdio の中継。依存ゼロ・Node 18+。URL を 1 つ引数に取り、stdin の JSON-RPC を `/mcp` に POST して応答を stdout に書くだけ。
- `initialize` で決まった版と `Mcp-Session-Id` を以後に付け、SSE の応答も読める。ツールも認可も SAI 側が決める。

### テスト

- `server/mcp/mcp.test.ts`（whois を差し替えた本物の `createApp`）と `server/mcp/bridge.test.ts`（中継を子プロセスで立てる）。
