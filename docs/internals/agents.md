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

### 送る・待つ

- 送るときは `deliveredText()` の見出し（`【SAI】#<project> の「<呼び名>」からのメッセージです（id: <message_id>）…`）を付けて、`launch()` に `queue: true` と `origin: message_id` で渡す。処理中なら #305 の預かりに並び、`StoredReply.origin` として持ち越す。
- `sai_wait` は `replyOf()` が見出しの id の入った相手のターン完了の行を探し、`clipReply()` で切って返す。相手の `Replying.failed` か、預かりの先頭のまま止まったら `failed`。
- 待つのはサーバ側（`wait=1` で `WAIT_MS`、MCP サーバが最長 30 分繰り返す）。
- 受け取った側の目印は見出しそのもの（画面は触っていない）。

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
- JSON-RPC は `server/mcp/protocol.ts` の `handleRpc()`（`initialize` / `ping` / `tools/list` / `tools/call`）、ツールの中身は `app.ts` の `mcpTools()`（`sai_sessions` / `sai_session` / `sai_progress` が読む、`sai_send` / `sai_wait` が送る・待つ）。
- `sai_sessions` の 1 行には、待ちと最後の記録の時刻も載せる（#323）。待ちは画面と同じく、端末で人が答えたぶんは `settleWaiting()` で畳み、返信中の答え待ちの承認 `approvalsNow()` も足す（1 行目だけ）。

### 誰に何を許すか

- tailnet の ACL（grants）で決める。`server/mcp/access.ts` の `mcpAccess()` が `tailscale whois` の最上段の `CapMap` にある `MCP_CAP`（`github.com/naturalclar/sai/cap/mcp`）の `tools` / `origins` を読む。Serve の `Tailscale-App-Capabilities` ヘッダは見ない（identity と同じく whois で引き直した値だけ）。
- ループバックと tailnet のユーザーは `read` が既定、`send` は capability、タグ付きの端末は capability だけ（無ければ 403）。
- `Origin` は無ければ（CLI）通し、あれば capability の `origins` に書いたものだけ。CORS もそれにだけ返す。

### 送る

- #310 の口に乗せる: 見出しは `deliveredFromTailnet()`（`isDeliveryOf()` / `replyOf()` がそのまま返答を探せる形）、`launch()` に `queue: true` と `origin`（受け取ったターンから先へ送らせない）、返答は `agentResult()`。
- 回数は `server/mcp/sendLimit.ts` の `McpSendLimiter`（呼んだ人ごとに 10 分 5 回。`mcp-sends.json` に残る）。
- 使用量の枠（`usageRefusal()`）と読み直させる量の予算（`budgetRefusal()`）は #311 の口と同じものを見る。予算の「1 ターン」の代わりは `McpSendLimiter.windowKey()`（10 分の区切り）で、`AgentMessages.record()` / `readInTurn()` にその鍵で載せる。
- 素通し（`bypassPermissions`）のセッションには送らない（`mcpSendRefusal()`）。
- `sai_wait` は最大 120 秒で返し、まだならもう一度呼ばせる。
- 送り元は `mcp:<ログイン名>` として記録し、本人だけが待てる。

### 中継（`feed/mcp/sai-mcp.mjs`）

- 呼ぶ側のマシンに置く stdio の中継。依存ゼロ・Node 18+。URL を 1 つ引数に取り、stdin の JSON-RPC を `/mcp` に POST して応答を stdout に書くだけ。
- `initialize` で決まった版と `Mcp-Session-Id` を以後に付け、SSE の応答も読める。ツールも認可も SAI 側が決める。

### テスト

- `server/mcp/mcp.test.ts`（whois を差し替えた本物の `createApp`）と `server/mcp/bridge.test.ts`（中継を子プロセスで立てる）。
