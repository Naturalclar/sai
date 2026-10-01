# 開発の道具（スキル・CI）の仕組み

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/tooling.md](../history/tooling.md)。

## `/setup-sai`（`.claude/skills/setup-sai/SKILL.md`）

- clone した直後の配線（フック / `notify` / OpenCode のプラグイン / `statusLine` → ビルド → 1 ターン届くかの確認）。
- 既存の設定を上書きしないのが主眼で、まず結果（`~/.agent-feed` の一番新しい行、使用率なら `usage-claude*.json`）を見て「もう届いているか」から入る（設定を辿るのはその後）。
- 1 つしか持てない枠（Codex の `notify`、Claude の `statusLine`）は特に、読んで見せてから畳む。書き込み無しの点検にも同じ手順を使う。

## `/sync-main`（`.claude/skills/sync-main/SKILL.md`）

- main worktree を最新の `main` に進めてビルドし直す。別の worktree から呼んでも main worktree だけを触る。
- 古いコードで動いているサーバは、そのペインで `pnpm start` に立て直す。一言の入切・口・モデルは `settings.json` に残っているので起動コマンドには付けない（#288）。

## `/manager`（`.claude/skills/manager/SKILL.md`。#323）

- SAI の記録を読み、どのセッションに何を送るとよいかを、宛先・根拠・そのまま貼れる本文の形で提案する。自分からは送らない（送るのは人がフィードの `@` から）。
- 読む口はリポジトリ直下の `.mcp.json` の `sai-read`（ループバックの `/mcp`。ループバックは `read` だけなので `sai_sessions` / `sai_session` / `sai_progress`。URL は `${SAI_PORT:-8787}`）。
- SAI が `--mcp-config` で渡す `sai` とは名前を分ける（あちらは同じ project しか見えず、`sai_send` で実際に送れる）。
- `.claude/settings.json` で許可を聞かずに通すのは `sai-read` の読むツール 3 つだけ。
- `claude -p` は `.mcp.json` を承認なしで繋ぐ（SAI から返信して回すターンにはそのまま付く）。端末で開いたセッションは最初に承認を聞かれる。
- `.mcp.json` の名前と URL・スキルが名指しするツール・許可の中身は、`server/mcp/mcp.test.ts` が `/mcp` の `tools/list` と突き合わせる。

## `/merge`（`.claude/skills/merge/SKILL.md`。#449）

- 別の目でのレビュー → 直す → PR のコメント → レビューした SHA で squash マージ → `merged: true` を見てから後始末。文書の置き場（#444）もここで見る。

## CI（`.github/workflows/ci.yml`）

- コミット前の一式（`pnpm test && pnpm test:feed && pnpm lint && pnpm typecheck`）＋ `pnpm build` を `main` への push と PR で回す。Node 22 系の最新、Python 3.9 と最新。

## 子プロセスを数える（`scripts/count-spawns.mjs`。#592）

- 応答の道で起こしている子プロセス（`ps` / `tmux` / `lsof` / `claude agents` / `gh` / `git`）を、口ごと・コマンドごとに数える preload。サーバのコードは触らず `node --import ./scripts/count-spawns.mjs server/main.ts --port <8787 以外>` で起こす。
- 数えるのは回数・起こす呼び出しそのものの時間（`posix_spawn` はイベントループの上で同期に走るので、その間サーバは全部止まる）・子が終わるまでの時間、それと口ごとの応答の時間。0.5 秒ごとに `SPAWN_COUNT_OUT`（既定 `/tmp/spawn-count.json`）に書き、`kill -USR2 <pid>` で数え直す。
- **本物の `~/.agent-feed` では回さない**。`AGENT_FEED_DIR` を一時ディレクトリにして日付の `*.jsonl` だけを写す（`replying.json`・預かり・`settings.json` は写さない。返信が二重に走る・本物の子を終わらせる・一言の `claude -p` が走るため）。`JEV_API_KEY` も渡さない。
- **口ごとの内訳は目安**。口は「その子を起こす走査を最初に始めた要求」に付く（`AsyncLocalStorage`）。走査は要求をまたいで 1 本に絞ってあるので、一覧と詳細が同時に来ると先に着いた方に全部付く。要求の中で始めたタイマーから後で起きた子も、その口に付く。**前後を比べるときは口ごとではなく合計で見る**。

