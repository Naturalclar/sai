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

### 送る・待つ

- 送るときは `deliveredText()` の見出し（`【SAI】#<project> の「<呼び名>」からのメッセージです（id: <message_id>）…`）を付けて、`launch()` に `queue: true` と `origin: message_id` で渡す。処理中なら #305 の預かりに並び、`StoredReply.origin` として持ち越す。
- `sai_wait` は `replyOf()` が見出しの id の入った相手のターン完了の行を探し、`clipReply()` で切って返す。相手の `Replying.failed` か、預かりの先頭のまま止まったら `failed`。
- 待つのはサーバ側（`wait=1` で `WAIT_MS`、MCP サーバが最長 30 分繰り返す）。
- 受け取った側の目印は見出しそのもの（画面は触っていない）。
- 見出しの「返答はどこへ行くか」は `REPLY_NOTE`（「このターンの最後の発言が返答として送り元の画面に出ます（送り元が sai_wait で待っていれば、そのまま受け取ります）」）。送り元が待たないこともあるので「送り元に返ります」とは言い切らない（#588）。

### 送り元の画面に返答を出す（#588）

- 送り元が `sai_wait` せずにターンを終えても、相手の返答を**送り元のセッション画面**に並べる。詳細の応答の `agent_replies` に、`shared/agentMessages.ts` の `agentReplyRows()` が作った行（相手のターン完了の行に `agent_reply`＝`message_id` / `to_name` / `sent_at` を付けたもの）を載せる。
- 行は 1 回だけ舐め、見出しの id（`deliveredId()`）で引き当てる（メッセージごとに `replyOf()` を呼ぶと 3 秒のポーリングのたびに 送った数 × 行 になる）。相手が違う行（見出しを写しただけ）は数えず、1 つのメッセージに 1 本（最初のターン完了）。描いている窓（`recent`）より前の返答は載せない。返答の id を詳細の `rev` に混ぜる。
- 呼び名は `replierName()`（表示名 → 題名。受け取った側の題名は届けた見出しそのものになっているので、そのときは worktree 名）。
- 画面は `SessionView` が `web/src/agentReplies.ts` の `withAgentReplies()` で時刻の順に混ぜて `Chat` に渡す。`toUtterances()` は `agent_reply` の行を相手のバブル 1 つにし（届いた文を自分のバブルにしない）、見出しに相手の呼び名と「送ったメッセージへの返答」（相手のセッションへのリンク）を出す。**このセッションの未読には数えず**（`firstUnreadKey()`）、「ここから未読にする」も出さない。
- 送り元の記録（JSONL）には書かない（SAI は行を起こさない）。フィードと要対応の未読の段には出さない（決まっていない）。

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

- 回数: `AgentMessages` が 1 ターン（送り元の `Replying.since`）に `AGENT_SEND_MAX`（3）回まで数える。
- 連鎖: `launch()` がメッセージで起動したターンを `agents.launched(id, origin)` で覚えて、そこからは送らせない（連鎖 1 段。人の返信で起動し直すと忘れる）。
- 使用量: `usageRefusal()` が相手のエージェントの枠（`UsageStore.get()`。5 時間 `AGENT_USAGE_STOP_PERCENT` = 80%、週 `AGENT_WEEKLY_STOP_PERCENT` = 95%、Claude の `limited`）を見て `429`。戻った枠と取れない使用量では止めない。
- 読み直させる量の予算 `AGENT_TURN_READ_BUDGET`（300 万トークン）:
  - 相手の大きさは `ProgressReader.read()` の `context_tokens`。`shared/progress.ts` が transcript の assistant の `usage` の入力 3 つの和 / rollout の `token_count` の `last_token_usage.input_tokens` を拾う（`total_token_usage` は積算なので使わない）。
  - `AgentMessages.readInTurn()` に足していき、`budgetRefusal()` が超えるなら `429`。大きさが分からない相手は足さない。
  - `sai_sessions` と `sai_send` の返事にも出す（エージェントが小さい相手を選べるように）。
- テストは `createApp` に偽の `UsageStore` / `ProgressReader` を渡す（本物は ~/.claude と ~/.codex を読む）。

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
- 素通し（`bypassPermissions`）のセッションには送らない（`mcpSendRefusal()`）。
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
