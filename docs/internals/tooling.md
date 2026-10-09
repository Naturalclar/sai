# 開発の道具（スキル・CI）の仕組み

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/tooling.md](../history/tooling.md)。

## `/setup-sai`（`.claude/skills/setup-sai/SKILL.md`）

- clone した直後の配線（フック / `notify` / OpenCode のプラグイン / `statusLine` → ビルド → 1 ターン届くかの確認）。
- 既存の設定を上書きしないのが主眼で、まず結果（`~/.agent-feed` の一番新しい行、使用率なら `usage-claude*.json`）を見て「もう届いているか」から入る（設定を辿るのはその後）。
- 1 つしか持てない枠（Codex の `notify`、Claude の `statusLine`）は特に、読んで見せてから畳む。書き込み無しの点検にも同じ手順を使う。

## `/sync-main`（`.claude/skills/sync-main/SKILL.md`）

- `sync.sh` 1 回で、main worktree の検出、lock、clean/main の確認、fetch、ff-only merge、install、build、サーバの状態確認と必要な再起動、digest・`X-SAI-Build` の検証まで行う（#687）。出力は10行以内の `key=value` に絞り、`/api/sessions` の本文は出さない。
- 別の worktree から呼んでも main worktree だけを触る。古いコードで動いているサーバは、そのペインで `pnpm start` に立て直す。一言の入切・口・モデルは `settings.json` に残っているので起動コマンドには付けない（#288）。切ならローカルの `qwen3:8b` を先に見て、無ければClaudeに設定する。
- **1 本ずつにする lock**（#580。`.claude/skills/sync-main/lock.sh`）。置き場は git の共通ディレクトリの `sai-sync-main.lock/`（`mkdir` で取る。中は `since` と `owner`）で、どの worktree から呼んでも同じ場所・main worktree の `git status` を汚さない。
  - 後から来た方は最長 480 秒待ち、取れたら普段の手順をそのまま回す（先の方が最新まで進めていれば fetch も立て直しの判定も「何もしない」になる。遅れていれば自分で進める）。待ち切れなければ終了コード 3 で、何も回さず報告する。
  - 落ちたまま残った lock は、取ってから 900 秒を過ぎたら次に来た方が引き取る。引き取りは `sai-sync-main.lock.takeover/` で 1 人ずつにし、その中でもう一度古いことを確かめてから消す。外せるのは取った本人（`owner` が同じ）だけ。`server/syncMainLock.test.ts` が回す。
- 立て直す前に、SAI の app-server が回している Codex のターン（`/api/sessions` の `replying` のうち、Codex で `via: terminal` でないもの）を見る。あれば立て直さない。エージェントが引けないもの（窓の外・行の無い新しいセッション）と、応答が読めなかったときも立て直さない。待つときは lock を外してから待つ。
- `server/syncMain.test.ts` は一時のbare repoとworktreeで、成功、dirty、main worktree不在、ff不可、build失敗、サーバ停止を通し、どの出口でもlockが残らないことと出力行数を確かめる。本物のmain worktreeと8787は触らない。

## `/manager`（`.claude/skills/manager/SKILL.md`。#323）

- SAI の記録を読み、どのセッションに何を送るとよいかを、宛先・根拠・そのまま貼れる本文の形で提案する。自分からは送らない（送るのは人がフィードの `@` から）。
- 読む口はリポジトリ直下の `.mcp.json` の `sai-read`（ループバックの `/mcp`。ループバックは `read` だけなので `sai_sessions` / `sai_session` / `sai_progress`。URL は `${SAI_PORT:-8787}`）。
- SAI が `--mcp-config` で渡す `sai` とは名前を分ける（あちらは同じ project しか見えず、`sai_send` で実際に送れる）。
- `.claude/settings.json` で許可を聞かずに通すのは `sai-read` の読むツール 3 つだけ。
- `claude -p` は `.mcp.json` を承認なしで繋ぐ（SAI から返信して回すターンにはそのまま付く）。端末で開いたセッションは最初に承認を聞かれる。
- `.mcp.json` の名前と URL・スキルが名指しするツール・許可の中身は、`server/mcp/mcp.test.ts` が `/mcp` の `tools/list` と突き合わせる。

## `/merge`（`.claude/skills/merge/SKILL.md`。#449）

- 別の目でのレビュー → 直す → PR のコメント → レビューした SHA で squash マージ → `merged: true` を見てから後始末。文書の置き場（#444）もここで見る。
- 後始末の最後に `/sync-main` を呼ぶ（#580）。手順は `/sync-main` の側にだけ置き、`/merge` には写さない。

- 積み重ねた PR のベースを `main` に付け替えるとき、`gh pr edit --base` が GraphQL の非推奨エラーで落ちたら `gh api -X PATCH repos/<owner>/<repo>/pulls/<番号> -f base=main`。
- マージは `gh api -X PUT repos/<owner>/<repo>/pulls/<番号>/merge -f merge_method=squash -f sha=<40 桁>`（HEAD が動いていれば `405`）。`/code-review <番号>` は別プロセスで動く。

## CI（`.github/workflows/ci.yml`）

- コミット前の一式（`bash scripts/suite.sh` が回す `pnpm test` / `test:feed` / `lint` / `typecheck`）＋ `pnpm build` を `main` への push と PR で回す。Node 22 系の最新、Python 3.9 と最新。

## 子プロセスを数える（`scripts/count-spawns.mjs`。#592）

- 応答の道で起こしている子プロセス（`ps` / `tmux` / `lsof` / `claude agents` / `gh` / `git`）を、口ごと・コマンドごとに数える preload。サーバのコードは触らず `node --import ./scripts/count-spawns.mjs server/main.ts --port <8787 以外>` で起こす。
- 数えるのは回数・起こす呼び出しそのものの時間（`posix_spawn` はイベントループの上で同期に走るので、その間サーバは全部止まる）・子が終わるまでの時間、それと口ごとの応答の時間。0.5 秒ごとに `SPAWN_COUNT_OUT`（既定 `/tmp/spawn-count.json`）に書き、`kill -USR2 <pid>` で数え直す。
- **本物の `~/.agent-feed` では回さない**。`AGENT_FEED_DIR` を一時ディレクトリにして日付の `*.jsonl` だけを写す（`replying.json`・預かり・`settings.json` は写さない。返信が二重に走る・本物の子を終わらせる・一言の `claude -p` が走るため）。`JEV_API_KEY` も渡さない。
- **口ごとの内訳は目安**。口は「その子を起こす走査を最初に始めた要求」に付く（`AsyncLocalStorage`）。走査は要求をまたいで 1 本に絞ってあるので、一覧と詳細が同時に来ると先に着いた方に全部付く。要求の中で始めたタイマーから後で起きた子も、その口に付く。**前後を比べるときは口ごとではなく合計で見る**。


## 記録を調べる（`pnpm feed`。#703）

`~/.agent-feed` を調べるときに、使い捨ての `python3` / `jq` を書く前に使う道具。**読むだけ**（置き場に何も書かない）で、置き場は `AGENT_FEED_DIR`（無ければ `~/.agent-feed`）。ファイルの形と間違えやすい所は [docs/data.md](../data.md#派生のファイル703)。

```
pnpm -s feed rows <セッション>           # あるセッションの最近の行（時刻・種類・入力と返答の頭）
pnpm -s feed messages                    # 送ったメッセージと、返答が届いたか（--session で送り元・宛先を絞る）
pnpm -s feed usage                       # セッション別の使用量。--by day で日別。費用は前の行との差
node --disable-warning=ExperimentalWarning server/tools/feed.ts rows <セッション>   # pnpm を通さない形（別の cwd からはこのパスを絶対で）
```

- **出力は既定で絞る**（結果は呼んだ側の文脈に残り続けるため）: 10 行・直近 7 日・入力と返答は頭だけ。見出しに「10 / 159 行（--all で全部）」と書く。広げるのは `-n <数>` / `--all`（全部）/ `--days <数>` / `--from` `--to`（`YYYY-MM-DD`。`Asia/Tokyo`）/ `--full`（切らない）。機械向けは `--json`。**そのコマンドで効かないオプション（`usage --session` など）・一緒に効かない組み合わせ（`--days` と `--from`、`--all` と `-n`）・存在しない日付はエラー（終了コード 2）**で、黙って無視しない。
- **セッションの指定**は ID・表示名・worktree 名・呼び名の完全一致（`sai_send` の宛先と同じ `resolveTarget()`。#625）で、ちょうど 1 つのときだけ読む。足してあるのは 2 つ: アーカイブしていない中で決まればそれを採る・名前で当たらなければ ID の頭（4 字以上）で引く。**決まらなければ読まずに候補を出して終了コード 1**（使い方の誤りは 2）。
- **`rows` の入力の欄は人の打った文とは限らない**ので印を付ける: 要約の文は `[要約]`、頭に足した返答の塊は外して `[返答 N 件]`、届いたメッセージは本文の `【SAI】` のまま（`--full` でも同じ）。`--json` は 1 行ごとに `prompt_kind`（`human` / `compact` / `message` / `empty`）と `handed`（足されていた返答の数）を添える。数えるのは `prompt_kind: "human"` だけ。`--json --full` の `user_text` は記録のまま。
- **`messages` の返答は記録の行で見る**。行があれば時刻と頭、無ければ「行なし」で、送り元に渡してあれば「行なし（… に送り元へ渡した）」（`--json` は `state`: `replied` / `handed` / `none`）。**「行なし」は未着とは限らない**: 完了の行が落ちて transcript から補った返答（#614）は JSONL に書かれないので、画面には出ていてもここでは見えない。
- `usage` が数えるのは `turn-usage.jsonl`（SAI から回したターンだけ）。画面の `#/usage` で足りるときはそちらを見る。絞ったときは「小計（上の N）」と「合計（全 N）」を分けて出す（`--json` は `shown_sum` と `sum`）。呼び名は表示名で足りればそれで出し、付いていないセッションがあるときだけ題名のために範囲の記録を読む。
- **読み方は `server/tools/feedRead.ts` の関数**で、その場かぎりの問いはこれを import して書く（サブコマンドにはしない）: `readRows(dir, range)`（`<host>` 付きも・SAI 自身の雑音は落とす）/ `dateRange()` / `rowEntity()` / `isTurn()` / `pairTurns()`（入力の行と完了の行の対応。`missing` = 完了の行が落ちた、`empty` = 本文が空、`open` = まだ来ていない）/ `promptKind()` と `humanPrompt()`（要約・届いたメッセージを人の入力から外す）/ `readTurnUsage()` → `usageRows()` → `usageTotals()` / `readAgentMessages()` → `messageReplies()` / `sessionsOf()` → `resolveSession()`。

  ```
  node --disable-warning=ExperimentalWarning --input-type=module -e "
  import { feedDir, dateRange, readRows, pairTurns } from './server/tools/feedRead.ts'
  const pairs = pairTurns(await readRows(feedDir(), dateRange({ days: 3 })))
  console.log(pairs.filter((p) => p.state === 'missing').length)"
  ```

- **読み方を新しく決めない・写さない**。判定は `shared/` のもの（`entityId()`・`eventKind()`・`localDate()`・`isCompactSummaryText()`・`turnCosts()`・`agentReplyRows()`・`resolveTarget()`・`isArchivedAt()`・入力の行を辿る `promptTracker()`）、ファイルの読み方はサーバのもの（`FeedStore.rowsOn()`・`MetaStore`・`parseTurnUsageLog()`・`isMessage()`）をそのまま呼ぶ。正本を TypeScript に置いたのはこのため（→ [経緯](../history/tooling.md#記録を調べる道具を-typescript-に置いた703)）。
- テストは `server/tools/feed.test.ts`（`pnpm test` に入る。一時ディレクトリの記録で回し、本物の置き場は触らない）。「費用を積み上げのまま足す」「要約の文を人の入力に数える」の 2 つを、間違えない例として入れてある。

## 一式を短い出力で回す（`scripts/suite.sh`。#688）

- `bash scripts/suite.sh` が `pnpm -s test` / `test:feed` / `lint` / `typecheck`（`--build` で `build` も）を順に回し、1 つにつき 1 行（`test=ok tests=… pass=… fail=…`、`lint=ok warnings=… errors=…`）と、最後に `status=ok` か `status=fail log=<置き場>` を出す。
- 落ちたものは、落ちた所だけを `SUITE_MAX_LINES`（既定 40）行まで出す: `test` は `not ok` の行、`test:feed` は `FAIL:` / `ERROR:` の行、`lint` は `[Error/…]` の行（警告は数だけ。oxlint の出力の形はエージェントの環境変数の有無で変わるので、`--format=unix` を指定して数える）、`typecheck` は `error TS` の行、`build` は末尾。全文は一時ディレクトリの `<名前>.log`（全部通れば消す）。
- どれかが落ちても残りは回す（1 回で全部の落ち方が分かる）。落ちたら exit 1。
- `package.json` のスクリプトにはしていない（CI は今までどおり 4 つを別々に回す。人が読むときは全文のほうがよい）。偽の `pnpm` で確かめるテストは `server/suite.test.ts`。
- `/setup-sai` の点検（一番新しい行・届いているフック・使用率のファイル・`statusLine`）は `.claude/skills/setup-sai/doctor.py`（読むだけ）。SKILL.md の本文に埋めていた Python を出したもの。

## テストを単体で回す

```
node --test --disable-warning=ExperimentalWarning server/rows/aggregate.test.ts
node --test --disable-warning=ExperimentalWarning --test-name-pattern="clip" server/rows/aggregate.test.ts
python3 -m unittest feed.test_record.RecordTest.test_garbage_stdin_exits_zero_and_records_nothing
python3 -m unittest feed.test_record -k synth
```

## Node と pnpm のバージョン

決まりは CLAUDE.md。ここは破ったときの出方と理由。

- サーバとテストは Node の型剥がしで `.ts` を直接実行するので **Node 22.18+**（`package.json` の `engines`）。古いと `ERR_UNKNOWN_FILE_EXTENSION`。応急処置は `node --experimental-strip-types ...`。
- **pnpm 12 系**（CI の `pnpm/action-setup` も `version: 12`）。12 系は `package.json` の `"pnpm"` を無視するので、設定は `pnpm-workspace.yaml` に置く。
  - `allowBuilds: { esbuild: true }` が無いと `ERR_PNPM_IGNORED_BUILDS`。
  - `packages: [.]` が無いと、入れ子の `pnpm typecheck` が `packages field missing or empty` で落ちる。
- `package.json` に `packageManager` を書かない。pnpm 12 は corepack のキャッシュに `bin/pnpm.cjs` を持たず、書くと入れ子の `pnpm` が `Cannot find module .../pnpm.cjs` で落ちる。

## 環境変数の表

表そのものは README の「環境変数」だけに置く（#675。前は CLAUDE.md にも同じ表があった）。`server/docs.test.ts` が README の表とコードを突き合わせる。

- **コードが読む変数は表に載っていること・表にあるものはコードが読むこと・2 つの小見出し（「設定することがあるもの」「切り分け・内部」）に分かれていて同じ変数が 2 回出てこないこと**を見る。変数を足したら README の表に足す。
- コードとして見るのは `.ts` / `.tsx` / `.js` / `.mjs` / `.py`（テストは除く）。
- 表に載せないもの（`server/docs.test.ts` の `INTERNAL`）:
  - `AGENT_FEED_SKIP`: SAI が一言を作る `claude -p` に自分で付ける合図。record.py / statusline.py / OpenCode のプラグインが見る。
  - `SAI_URL` / `SAI_ENTITY` / `SAI_TOKEN_FILE` / `SAI_LOOP`: `server/reply/runner.ts` が `--mcp-config` の env で `server/approvals/approve-mcp.ts` に渡す。`SAI_TOKEN_FILE` はエージェント用の口のトークンを置いたファイル（#310）、`SAI_LOOP` はループの周のターンの印（#634）。
  - `SAI_APPROVE_RECONNECT_MS`: `approve-mcp.ts` が SAI に届かないとき繋ぎ直しを続ける長さ。テストが短くするためだけで、SAI は渡さない（#440）。
  - `TMUX_PANE` / `CLAUDE_PID`: エージェントが record.py に渡してくる。
  - `REPO_URL` / `PROD`: Vite の `import.meta.env`。
  - `PATH`: フックのラッパーを引く（#567）。
- **実行ファイル（`claude` / `codex` / `opencode` / `tmux` / `git` / `gh` / `tailscale` / `sips`）はサーバの `PATH` から探す。** `replyCommand()` / `summarizeCommand()` / `codexQueueCommand()` / `realCodexConnector()` は名前を固定、`RealTmux` / `RealGit` / `GhPr` はコンストラクタの既定値、`sips` は `sipsShrink()`。テストは偽物を引数で渡す。`tailscaleBins()` は PATH の後に macOS の GUI 版を試す。
- 読む場所が決まっている変数:
  - `SAI_HOME`: README のフック設定例（`settings.json` の `env`）と、OpenCode のプラグイン（`feed/opencode/sai.js` の `recordPath()`。無ければ置いたファイルの隣から辿る）が使う。`record.py` とサーバは読まない。
  - `SAI_PORT`: `web/vite.config.ts` の `/api` の proxy 先もこれ（判定は `shared/port.ts`。`--port` は Vite から見えない）。
  - `AGENT_FEED_HOST`: 既定は `gethostname()` / `os.hostname()` の短い形。record.py は行の `host` に載せ（合成セッションもこれで割る。設定したときだけ書き込み先が `YYYY-MM-DD.<host>.jsonl` になる。#113）、サーバは `server/host.ts` の `selfHost()` で自分の名前にして応答の `host` に載せる（行の `host` と違えば「別のマシン」= 返信不可。#114）。
  - `JEV_API_KEY`: 読むのは `server/main.ts` の `jevFromEnv()` だけ（`createApp` の既定は送らない。#491）。`settings.json` の `jev` で切れる。
  - `SAI_DIGEST_URL` / `SAI_DIGEST_API_KEY`: 口が `openai` のときの base URL（既定 `http://127.0.0.1:11434/v1`）と鍵。入切・口・モデルは `settings.json`。
  - `SAI_CLAUDE_ARGS` / `SAI_CODEX_ARGS` / `SAI_OPENCODE_ARGS`: シェル風に割る（`server/reply/runner.ts` の `splitArgs()`）。Claude は先頭に置く（`--allowedTools` は可変長で、後ろだと本文を飲む）。`SAI_CODEX_APP_SERVER_ARGS` は `codex app-server --stdio` の引数。
  - `SAI_TERMINAL` / `SAI_APPROVE` / `SAI_CODEX_APP_SERVER` / `SAI_OPENCODE_SERVER` / `SAI_CLAUDE_AGENTS`（#418） / `SAI_GH`: どれも `0` で経路を切る。`SAI_OPENCODE_SERVER=0` は `opencode run -s` に戻す（#382）。`SAI_APPROVE=0` は `--permission-prompt-tool` の配線を付けない。`SAI_GH` が叩く形は `gh pr view` / `gh pr list` / `gh pr diff` / `gh api user` / `gh api -X GET …/pulls/<番号>/comments`（#600）と、人が押したときの `gh api -X POST …/reviews`。
  - `CODEX_HOME`（既定 `~/.codex`）/ `GROK_HOME`（既定 `~/.grok`。`record.py` が `sessions/` を読む）: それぞれのエージェント自身の変数に従うだけ。`AGENT_FEED_DEBUG` は `1` で record.py の例外をログに残し、statusline.py は描画ごとの入力の要点を `statusline-debug.log` に足す（#694）。
