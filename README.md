# SAI — 複数 AI エージェントを跨いだチャット風インターフェース

Claude Code と Codex CLI のターン完了をフックで1本の流れに集めて、**左にセッション一覧、右にチャット**の1画面で眺める。「さっきのあれ、どのセッションでやったんだっけ」を、端末のスクロールバックではなく画面で引けるようにするためのもの。

名前は『ヒカルの碁』の藤原佐為から。自分とは別の打ち手の声が自分の側にいる存在で、打たれた碁を全部見ている。

| | |
| --- | --- |
| **SAI** | 見る側。セッション一覧と会話画面。`web/` |
| **agent-feed** | 集める側。フックが1行ずつ JSONL に追記する配管。`feed/` |

配管（何をどう記録するか）と見え方（どう並べるか）は別々に作り替わるので、名前も分けてある。置き場はこのリポジトリ1つ。履歴（JSONL）は `.gitignore` で外してあるので、実装だけが載る。

```
sai/
├── package.json         … pnpm。画面とサーバをまとめて扱う。lint は oxlint
├── feed/
│   ├── record.py        … フックから呼ばれて1行 append する（Python）
│   └── test_record.py
├── shared/
│   ├── types.ts         … 1行の形と API の形。サーバと画面が両方 import する
│   └── entity.ts        … エンティティID（(セッション, リポジトリ) の組）の作り方
├── server/              … 127.0.0.1 専用の HTTP サーバ（TypeScript / Node）。集計と API、dist/ の配信
│   ├── main.ts          … 入口。引数と bind 先のチェック
│   ├── app.ts           … ルーティング
│   ├── store.ts         … 日付ファイルの読み込みと (mtime, size) キャッシュ
│   ├── aggregate.ts     … 行 → セッションの集計
│   └── *.test.ts        … node:test
└── web/
    ├── src/             … 画面（React + TypeScript）
    ├── vite.config.ts
    └── dist/            … `pnpm build` の成果物（コミットしない）
```

**フックだけ Python**（3.9+ 標準ライブラリのみ）。毎ターン、エージェントの子プロセスとして PATH が最小の環境で呼ばれうるので、`node` が見つからず黙って止まるリスクを避けるため。サーバと画面は pnpm + TypeScript で、サーバは Node 22.18+ の型剥がしで `.ts` を直接動かす（ビルド不要）。

## 使い方

clone したところで Claude Code を開いているなら、**`/setup-sai`** が下の 1〜4 を代わりにやる（`.claude/skills/setup-sai/SKILL.md`）。フックや `notify` / `statusLine` に既に別のものが入っていても、**読んで差分を見せてから足す**ので消えない。「記録が来ない」「使用率が出ない」ときの点検（書き込み無し）にも使える。以下は自分で書くときの正本。

### 1. フックを向ける

**Claude Code** — `~/.claude/settings.json`（全リポジトリ）か `.claude/settings.json`（そのリポジトリだけ）に。`record.py` の場所は `env` の `SAI_HOME` に1回だけ書き、各フックはそれを参照する:

```json
{
  "env": { "SAI_HOME": "/path/to/sai" },
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "python3 \"$SAI_HOME/feed/record.py\" || true" } ] }
    ],
    "PermissionRequest": [
      { "hooks": [ { "type": "command", "command": "python3 \"$SAI_HOME/feed/record.py\" || true" } ] }
    ],
    "PreToolUse": [
      { "matcher": "AskUserQuestion|ExitPlanMode", "hooks": [ { "type": "command", "command": "python3 \"$SAI_HOME/feed/record.py\" || true" } ] }
    ],
    "Notification": [
      { "matcher": "idle_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog|permission_prompt", "hooks": [ { "type": "command", "command": "python3 \"$SAI_HOME/feed/record.py\" || true" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "python3 \"$SAI_HOME/feed/record.py\" || true" } ] }
    ]
  }
}
```

- `env` の値はセッションとそのサブプロセスに渡るので、フックのコマンドからも `$SAI_HOME` で見える。フックのコマンドはシェル（`sh -c`）で動くので変数はそのまま展開される。シェルの rc で `export SAI_HOME=...` しておいても同じ
- `|| true` は保険。`SAI_HOME` が未設定・間違いだと `python3` がファイルを見つけられず exit 2 になり、`Stop` フックの exit 2 は「Claude を止めない」の意味なので、付けないとターンが終われなくなる。`record.py` 自身は常に exit 0 なので、これで潰れるのはパスの間違いだけ

`Stop` だけでもターンは記録される。`UserPromptSubmit` は入力した瞬間に自分の入力をチャットに出すためのもの。残りは**人を待って止まったとき**に「何を待っているか」を出すためのもの:

| フック | いつ鳴るか | 行にするもの |
| --- | --- | --- |
| `PermissionRequest` | ツール実行の許可ダイアログが出た瞬間 | `許可待ち: Bash: rm -rf node_modules` のように、ツール名と入力の要約 |
| `PreToolUse`（`AskUserQuestion` / `ExitPlanMode` だけ） | 質問・プランの承認を求めた | `質問: どのフレームワーク?` / `プランの承認待ち: <先頭3行>`。他のツールで鳴っても何も書かない |
| `Notification` | 入力待ちなどが 6〜60 秒続いた | `入力待ち` など型ごとの日本語。`permission_prompt` は直前が許可待ちの行なら重ねない。`auth_success` や `agent_completed` のような待ちでない型は書かない |
| `UserPromptSubmit` | 人が入力した | `user_text` に打った文をそのまま載せた行（本文 `text` は無い）。ターン完了を待たずに自分側のバブルが出る。直前が待ちの行なら、その解消の合図にもなる。入力が取れなかったときは待ちの直後だけ合図として書く。バックグラウンドのタスク完了で Claude Code が差し込む `<task-notification>` でも鳴るが、人の入力ではないので載せない（同じく待ちの直後だけ合図） |

`record.py` は待ちのフックで **stdout に何も出さない**（`decision` を出すと許可の判断そのものに触ってしまう）。許可するかどうかはいつも通り端末で答える。

Codex の `notify` はターン完了時にしか来ない。Codex が tmux で開いていれば、SAI サーバが画面のポーリング時にそのペインを確認し、質問・許可ダイアログ中なら一覧とチャットに「Codex の画面で回答待ち」を一時表示する。通常起動の Codex TUI から質問内容や選択肢を構造化して受け取る口はないため、回答は tmux の画面で行う。ダイアログが閉じれば表示も消え、JSONL の履歴には残らない。

SAI から閉じた Codex セッションへ返信するときは、SAIサーバー配下で長寿命の `codex app-server --stdio` を保持し、`thread/resume` → `turn/start` を行う。コマンド・ファイル変更・追加権限の承認と `request_user_input` は同じJSON-RPC接続で受け、提示された選択肢だけをSAIに表示して回答を返す。通常起動のTUIは所有しないので、上記のtmux表示または `codex queue` のまま。Codex CLI 0.153.2以降を想定し、問題があれば `SAI_CODEX_APP_SERVER=0` で従来の `codex exec resume` に戻せる（この場合、SAIからCodexの質問・許可には答えられない）。

**フックは足し算で鳴る。** リポジトリ側の `.claude/settings.json` にも `Stop` フックがあると、ユーザー設定の分と両方が動いて 1 ターンが 2 行になる（試作を置いていたリポジトリで実際に起きた）。SAI を更新したら `record.py` の向け先も同じ checkout を指しているか確かめる。**記録側が古いと画面が知らせる**: 行には `v`（`record.py` の `RECORD_VERSION`）が載り、窓の中の一番新しい行の `v` が最新より小さいとヘッダの下に「記録側の `record.py` が古い」と出る。`v` の無い行は試作か古い `record.py` のもの。

**Codex CLI** — `~/.codex/config.toml` に:

```toml
notify = ["python3", "/absolute/path/to/sai/feed/record.py"]
```

こちらは絶対パスで。`notify` は引数の配列をそのまま実行する（シェルを通らない）ので、`$SAI_HOME` のような変数は展開されない。`notify` の JSON が「最後の引数」で来るか stdin で来るかは資料によって食い違うので、`record.py` は両方受ける。

**`notify` は 1 つしか持てない。** Codex Computer Use のクライアントなど、すでに別の受け手を `notify` に入れているなら、上をそのまま書くとそちらが動かなくなる（逆に、そちらを残したままだと SAI に Codex の行が 1 行も来ない）。その場合は受け手を順に呼ぶ小さなラッパーを 1 つ置いて、`notify` はそれだけを指す。Codex が最後の引数に付けるイベントの JSON を `"$@"` でそのまま渡す。どれかが失敗しても他を止めず、常に exit 0:

```sh
#!/usr/bin/env bash
# sai-codex-notify - Codex の notify を複数の受け手に配る
set -uo pipefail
cu="$HOME/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
[ -x "$cu" ] && "$cu" turn-ended "$@" >/dev/null 2>&1 || true
script="${SAI_HOME:-$HOME/src/sai}/feed/record.py"
[ -f "$script" ] && python3 "$script" "$@" >/dev/null 2>&1 || true
exit 0
```

```toml
notify = ["/Users/<me>/.scripts/sai-codex-notify"]
```

ラッパーはシェルスクリプトなので、その中では `$SAI_HOME` が使える。向け直したら Codex で 1 ターン回し、`~/.agent-feed/` の行に `"agent": "codex"` が増えて `session_source` が `rollout` になることを見る（`synth` なら [docs/design-notes.md](docs/design-notes.md) の「Codex の notify ペイロードにセッションIDが無い」を疑う）。

**OpenCode** — フックの仕組みが無く、**プラグイン**でイベントを受ける。このリポジトリの `feed/opencode/sai.js` を OpenCode のプラグイン置き場に置く（全プロジェクトなら `~/.config/opencode/plugin/`、そのプロジェクトだけなら `.opencode/plugin/`）:

```
mkdir -p ~/.config/opencode/plugin
ln -s "$SAI_HOME/feed/opencode/sai.js" ~/.config/opencode/plugin/sai.js
```

`record.py` の在り処はプラグインが `SAI_HOME` から引く。無ければ**置いたファイルの隣**（`feed/opencode/` → `feed/`）から辿るので、symlink ならそのままでも動く（中身をコピーしたなら `SAI_HOME` が要る）。

プラグインは `session.idle`（ターン完了）で最後のアシスタントの発話と直前の入力を、`permission.asked` / `permission.replied` で待ちと再開を `record.py --agent opencode` に渡す。**OpenCode ぶんの payload はプラグインが組み立てるので、形では当てられず送り側が名乗る**（`--agent`）。Claude と Codex の設定は今までどおり形で判定するので触らなくてよい。

向け直したら OpenCode で 1 ターン回し、`~/.agent-feed/` に `"agent": "opencode"` の行が増えることを見る。`session_source` は `payload`（セッションIDがイベントに載っている）。

許可を SAI の画面から答える口は無い（Claude の `--permission-prompt-tool` に当たるものが無い）ので、`permission.asked` は**待ちの行として出すだけ**で、答えるのは端末側。

**閉じているセッションへの SAI からの返信（`opencode run -s`）は、許可が要るツールを自動で拒否する**（非対話なので聞けない）。ツールが失敗した時点でターンが終わり、アシスタントは本文を書かないので、チャットには `（本文なし）read の許可が拒否されて終わりました（…）` のように**何が起きたか**を出す（#273）。許可が要る作業を返信で頼むときは、**端末（tmux）で開いてから返信する**（TUI に打ち込むので、ダイアログで答えられる）。`opencode run` には `--auto`（許可を自動で通す。本人も dangerous と書いている）しか口が無く、**SAI からは付けない**。付けるなら運用者が `SAI_OPENCODE_ARGS` で明示的に渡す（そのセッションへの返信では「同一オリジンの検査」が唯一の砦になる。Claude の素通しと同じ）。プロバイダを差し替えれば手元のモデルでも動く → [docs/local-llm.md](docs/local-llm.md)。

### 2. 画面をビルドしてサーバを立てる

```
pnpm install && pnpm build
pnpm start                                   # http://127.0.0.1:8787/
pnpm start --port 9000 --feed-dir ~/.agent-feed   # pnpm は「--」もそのまま渡すが、先頭の「--」は落とすので付けてもよい
```

pnpm は 12 系（設定は `pnpm-workspace.yaml`）、Node は 22.18 以上が要る。

サーバは `web/dist/` を配る。未ビルドなら `/` にその旨が出る。`file://` で開くと fetch が CORS で止まるので、必ずこのサーバ経由で開く。`127.0.0.1` 以外には bind を拒否する。

画面を触るときはサーバを立てたまま `pnpm dev`。Vite が `/api` をサーバに流す（流す先は `SAI_PORT`。既定は `127.0.0.1:8787`）。**`pnpm start --port 9000` のような起動引数は Vite からは見えない**ので、ポートを変えるなら `SAI_PORT` も同じ値にする（`SAI_PORT` がおかしい値なら既定に落ちて、Vite の起動時に警告が出る）。

`main` を取り込んだときは、サーバを止めずに別のターミナルで `git pull && pnpm build` するだけでいい。 Claude Code からなら `/sync-main`（`.claude/skills/sync-main/SKILL.md`）が、main worktree の fetch → ff-only merge → `pnpm install` → `pnpm build` → サーバが追従したかの確認までをやる（別の worktree から呼んでも main worktree だけを触る）。サーバが古いコードのままなら、動いているペインで一言つき（既定はローカルの `qwen3:8b`）に立て直すところまでやる。止まっているサーバは起動しない。`pnpm build` を忘れて `web/dist/` が `web/src` / `shared` より古いままだと、画面のヘッダの下に「画面のビルドが古い」と出る（サーバが mtime を比べて `build_stale` で伝える。`pnpm dev` では出ない）。サーバは `web/dist/` を毎回ディスクから読み、`/api/*` の応答に `X-SAI-Build`（`dist/index.html` の更新時刻）を付けるので、開いているブラウザは 3 秒以内に自分でリロードする。`server/` や `shared/` が変わったときの再起動まで任せたければ `pnpm start:watch`（`node --watch`）で立てる。

```
pnpm lint        # oxlint（web/src, server, shared）
pnpm typecheck   # tsc（web と server の両方）
pnpm test        # node:test（server/、shared/、web/src/）
pnpm test:feed   # python3 -m unittest（feed/）
pnpm build       # typecheck してから vite build
pnpm start:watch # server/ shared/ が変わったら自動で再起動（node --watch）
```

iPad やスマホから見たいときは、tailnet の中にだけ出せる（[docs/tailnet.md](docs/tailnet.md)）。

### 3. 確かめる

- Claude で1ターン回す → `~/.agent-feed/YYYY-MM-DD.jsonl` が1行増え、`session_source` が `payload`
- Codex で1ターン回す → 1行増え、`session_source` が `rollout`（`synth` になるなら [docs/design-notes.md](docs/design-notes.md) を疑う）
- `echo 'not json at all' | python3 feed/record.py; echo $?` → `0` で、行は増えない

テスト:

```
pnpm test && pnpm test:feed && pnpm lint && pnpm typecheck
```

同じ一式（＋ `pnpm build`）を GitHub Actions でも回す（`.github/workflows/ci.yml`）。`main` への push と PR が対象で、Node は 22 系の最新、Python は 3.9 と最新の両方。

### 4. Claude の使用率を出す（任意）

ヘッダの使用量に **Claude の 5 時間・週の使用率**を出すための設定（[#250](https://github.com/Naturalclar/sai/issues/250)）。要らなければ飛ばしてよい（設定しなければ、上限に当たったときだけ「上限中」と出る）。

**割合はステータスライン経由でしか手元に来ない。** `claude` CLI に `usage` のサブコマンドは無く、TUI の `/usage` が叩いている API は OAuth のトークンが要るので SAI は使わない。一方、`statusLine` に指定したコマンドには**描画のたびに** `rate_limits`（5 時間・週の `used_percentage` と復帰時刻）を含む JSON が stdin で渡る。それを受け取って置いておくのが `feed/statusline.py`。

`~/.claude/settings.json` に:

```json
{
  "statusLine": { "type": "command", "command": "python3 \"$SAI_HOME/feed/statusline.py\"" }
}
```

**stdout に出したものがそのままステータスラインになる。** `statusline.py` は `Opus 5 · 5時間 43% · 週 71%` のような1行を出す。

**`statusLine` は 1 つしか持てない。** すでに自分のステータスラインを使っているなら、両方に同じ JSON を配る小さなラッパーを置いて、`statusLine` はそれだけを指す（Codex の `notify` と同じやり方）。SAI 側の出力は捨て、今までの表示をそのまま使う:

```sh
#!/usr/bin/env bash
# sai-statusline - ステータスラインの JSON を SAI にも配る
set -uo pipefail
input=$(cat)
printf '%s' "$input" | python3 "${SAI_HOME:-$HOME/src/sai}/feed/statusline.py" >/dev/null 2>&1 || true
printf '%s' "$input" | 今までのコマンド      # ここの出力がステータスラインになる
exit 0
```

設定したら Claude で1ターン回し、`~/.agent-feed/usage-claude.json` ができて `rate_limits` が入っていることを見る。**`rate_limits` は subscription のときだけ、かつ最初の API 応答の後に載る**（API キー利用では出ない）。

- 割合は **Claude が動いている間しか更新されない**。枠の復帰時刻を過ぎたものは画面に出さない
- `AGENT_FEED_HOST` を設定していればファイルもマシンごとに分かれる（`usage-claude.<host>.json`）。SAI は全部読んで一番新しいものを使う

### 5. 別のマシンの分も見る（任意）

1 台で使うなら要らない。**複数のマシンで回している分を 1 つの画面で眺めたい**ときだけ設定する（[#24](https://github.com/Naturalclar/sai/issues/24)）。SAI 自身は他のマシンに通信しない（「SAI は外に出さない」は変わらない）。集めるのは**外の道具（rsync / 同期フォルダ）の仕事**で、SAI は置き場にあるファイルを読むだけ。

**まず各マシンで `AGENT_FEED_HOST` を設定する。** フックやプラグインの向け先は今までどおり（そのマシンの checkout の `record.py`）で、環境変数を 1 つ足すだけ。**シェルの設定に置くのが確実**で、そこから起動する Claude / Codex / OpenCode のどれもが `record.py` に渡す:

```sh
# ~/.zshrc など
export AGENT_FEED_HOST=mini
```

Claude だけなら `settings.json` の `env` でもよい（`notify` はシェルを通らないので **Codex には効かない**。OpenCode のプラグインは OpenCode のプロセスの環境を継ぐ）:

```json
{
  "env": { "SAI_HOME": "/path/to/sai", "AGENT_FEED_HOST": "mini" }
}
```

これで行に `host` が載り、書き込み先が `~/.agent-feed/YYYY-MM-DD.mini.jsonl` に分かれる（設定しないと今までどおり `YYYY-MM-DD.jsonl`）。**マシンごとに違う短い名前**にする。

**画面を開くマシンでは、サーバも同じ `AGENT_FEED_HOST` を見る。** 自分の名前を記録側と同じ変数・同じ規則で決めるので、シェルの設定に置いていれば、そのシェルから `pnpm start` するだけで揃う（何も設定しなければ両方 `hostname` を見る）。`settings.json` の `env` にだけ書いた場合はサーバに届かないので、起動するときに渡す:

```sh
AGENT_FEED_HOST=mac pnpm start   # シェルの設定に置いていれば不要
```

ずれると SAI は自分のセッションを「別のマシン」と見なし、**自分の返信の口まで消える**。前はサーバ側だけ `SAI_HOST` という別の変数で、片方だけ設定するとずれていた（#288 でやめた。`SAI_HOST` はもう読まない）。

#### 集め方 1: rsync（勧める方）

見る側のマシンで、記録側から `.jsonl` を**片方向に**引いてくる。片方向なので書き込みがぶつからない。

```sh
rsync -a --include='????-??-??.*.jsonl' --exclude='*' mini:~/.agent-feed/ ~/.agent-feed/
```

**`--include` をこの形にするのは大事**（`'*.jsonl'` にしない）。`????-??-??.*.jsonl` は「日付 + host」のファイルだけに当たるので:

- 相手の `digest.jsonl`（一言のキャッシュ）で**自分のを上書きしない**
- 相手が `AGENT_FEED_HOST` を設定し忘れて `YYYY-MM-DD.jsonl` に書いていても、**自分の同名のファイルを潰さない**（代わりに何も来ないので、行が増えなければまずここを疑う）
- `session-meta.json`・`session-icons/`・`attachments/` も持ってこない（表示名やアイコンは見る側のものが正）

`--delete` は付けない（相手で消えても手元には残る）。rsync は既定でテンポラリに書いてから rename するので、転送中の半端なファイルが SAI に見えることはない。

1 分ごとに回すなら cron:

```
* * * * * /usr/bin/rsync -a --include='????-??-??.*.jsonl' --exclude='*' mini:~/.agent-feed/ ~/.agent-feed/ >/dev/null 2>&1
```

**tailnet 越しなら Tailscale SSH**（相手で `tailscale up --ssh`、ACL で許可）にしておくと鍵を配らなくてよい。相手側に `rsync` が要る。

#### 集め方 2: 同期フォルダ（iCloud Drive / Syncthing）

両方のマシンの `AGENT_FEED_DIR` を同じ同期フォルダに向ける。日付ファイルがマシンごとに分かれているので、追記がぶつかって競合コピーができることはない。

ただし **`session-meta.json` / `session-icons/` / `digest.jsonl` も同じフォルダに入る**（表示名・アイコン・一言はマシンごとではない）。これらは同時に書くと競合するので、**画面を開くのが 1 台のときだけ**にする。同期の途中で末尾が切れた行は SAI が落とすので、次のポーリングで揃う。

#### そのあと

- 一覧・フィード・チャット見出しに `@mini` の印が付き、**別のマシンのセッションには返信の口が出ない**（CLI もその履歴もあちら側にあるので、ここで再開しても続きにならない）。サイドバーに「マシン」の絞り込みが増える
- 自分のセッションにまで `@` の印が付いて返信できないなら、サーバが記録側と違う `AGENT_FEED_HOST` で動いている（上。`settings.json` の `env` にだけ書いてサーバには渡っていない、など）
- **`record.py` は両方のマシンで更新する。** 行の形の版（`v`）はマシンごとに違いうるので、古い方の行が一番新しいと画面に「record.py が古い」が出る

## もっと詳しく

使い方の先（何がどう記録され、画面がどう出し、API が何を返すか）は `docs/` にある。

| | |
| --- | --- |
| [docs/screen.md](docs/screen.md) | 画面の見え方、チャット、返信（tmux への打ち込み / 別プロセス）、許可・質問、差分、使用量、一言コメント |
| [docs/api.md](docs/api.md) | エンドポイントの一覧と、集計・返信の実行の中身 |
| [docs/data.md](docs/data.md) | JSONL の1行の形、表示名とアイコン、アーカイブ |
| [docs/design-notes.md](docs/design-notes.md) | 先に確かめた前提（セッション終了は掴めない、Codex のセッションID、待ちの行、思考の量、リモートの行は見るだけ、クラウドセッションは対象外） |
| [docs/local-llm.md](docs/local-llm.md) | ローカル LLM（Ollama / LM Studio）で使う。CLI の向き先の変え方と、返信の経路ごとの違い |
| [docs/tailnet.md](docs/tailnet.md) | tailnet（Tailscale Serve）に出すときの手順と認証 |

## 守ること

- **`record.py` は絶対に失敗しない。** 必ず exit 0。フックが落ちるとエージェント本体を止めてしまうので、記録に失敗しても黙って諦める。何が起きたか見たいときは `AGENT_FEED_DEBUG=1` で `~/.agent-feed/record-errors.log` に残る。15秒で自分を殺す保険も入っている
- **本物の Slack には投げない。** 投げ先が会社のワークスペースになるので、個人リポジトリのセッション記録がそこに流れるのは避ける
- **SAI は外に出さない。** `127.0.0.1` 限定。デプロイもホスティングもしない。中身は作業内容そのもの。出してよいのは **tailnet まで**で、それも `tailscale serve`（前段のプロキシ）経由だけ。アプリ自身の bind は変えないし、`tailscale funnel` は使わない。Serve のヘッダは `whois` で突き合わせ、合わなければ `401`
- **ブラウザからコマンドが走る。** 返信は `claude` / `codex` を任意の `cwd` で起動する。ローカルで開いている別サイトからの CSRF でエージェントを走らせないよう、`POST` は `Origin` / `Sec-Fetch-Site` が同一オリジンでなければ `403`（どちらも無い curl などブラウザ以外は通す）。この確認は外さない。**素通し（`bypassPermissions`）を選んだセッションでは、この検査が唯一の砦になる**（#253。それ以外のセッションでは「CLI が未許可のツールを拒否する」が二重目の歯止めとして残る）。SAI 自身が既定で権限のフラグを付けることはしない
- **一言（digest）は本文を LLM に送る。** `SAI_DIGEST=1` のときだけで、既定はオフ。既定は返信と同じ `claude` CLI 経由で、仕事のリポジトリの返答をそのまま要約に出すことになるのは分かって使う。外に出したくなければ `SAI_DIGEST_PROVIDER=openai` でローカルの LLM に向ける（`SAI_DIGEST_URL` が `127.0.0.1` を指している限り本文は手元から出ない）
- **一覧のタイトルに機密が乗りうる。** 仕事のリポジトリのセッションだと issue の内容がそのまま出る。スクリーンショットを撮るときは自分で気をつける

## 環境変数

**どれも省略できる**（何も設定しなくても既定値で動く）。1 台で使うだけなら、設定するのは一言（digest）を使うときの `SAI_DIGEST` 系くらい。

### 設定することがあるもの

| | |
| --- | --- |
| `SAI_HOME` | このリポジトリの場所。上のフック設定例が `$SAI_HOME/feed/record.py` として使い、OpenCode のプラグイン（`feed/opencode/sai.js`）も `record.py` を探すのに読む（無ければ置いたファイルの隣から辿る）。`record.py` とサーバ自身は読まない |
| `AGENT_FEED_DIR` | 出力先（既定 `~/.agent-feed`）。`record.py` とサーバの両方が見る |
| `SAI_PORT` | サーバの既定ポート（既定 `8787`）。`pnpm dev` の `/api` の proxy 先もこれ（`--port` は見ない。#146） |
| `AGENT_FEED_HOST` | このマシンの名前（既定は `gethostname()` の短い形）。複数のマシンの JSONL を 1 か所に集めるときに、行の出どころを分ける。**設定すると書き込み先も `YYYY-MM-DD.<host>.jsonl` に分かれる**（同期フォルダで同じファイルに追記して壊れるのを避けるため。サーバは両方の形を全部読む）。**サーバも自分の名前をこれで決め**、行の `host` と違うセッションは「別のマシン」として印を付け、返信の口を出さない（記録側とサーバを同じ環境から起動すれば揃う。前はサーバ側だけ `SAI_HOST` だった。#288） |
| `SAI_DIGEST` | `1` で一言コメント（digest）を作る。既定はオフ |
| `SAI_DIGEST_PROVIDER` | 一言を作る口。`claude`（既定。`claude -p`）か `openai`（OpenAI 互換の `/v1/chat/completions`。Ollama / LM Studio などローカルの LLM はこちら） |
| `SAI_DIGEST_MODEL` | 一言を作るモデル。`claude` なら既定 `haiku`（`claude -p --model` にそのまま渡す）。`openai` なら必須（`qwen3:8b` のようなローカルのモデル名。無ければ一言を作らないでサーバは立つ） |
| `SAI_DIGEST_URL` | `openai` のときの base URL（既定 `http://127.0.0.1:11434/v1` = Ollama。LM Studio は `http://127.0.0.1:1234/v1`）。末尾に `/chat/completions` を足して叩く |
| `SAI_DIGEST_API_KEY` | `openai` のときの鍵（任意。`Authorization: Bearer`）。Ollama / LM Studio は不要 |
| `SAI_CLAUDE_ARGS` | 返信の `claude -p --resume` に足す引数。空白区切りで、空白を含む値は `"…"` か `'…'` で囲む。例: `--allowedTools "Bash(gh *)"`（許可モードとモデルは入力欄でセッションごとに選べる）。「返信と許可」の項を読んでから |
| `SAI_CODEX_ARGS` | 開いている Codex の `codex queue` と、`SAI_CODEX_APP_SERVER=0` の `codex exec resume` に足す引数。例: `-s workspace-write` |
| `SAI_CODEX_APP_SERVER_ARGS` | `codex app-server --stdio` に足す引数。空白を含む値は引用符で囲む。例: `-c sandbox_mode="workspace-write"` |
| `SAI_OPENCODE_ARGS` | 同じく `opencode run` に足す引数。例: `--agent build` |

### 切り分け・内部

普段は設定しない。うまく動かないときに経路を切る・ログを残すためのもの。

**実行ファイル（`claude` / `codex` / `opencode` / `tmux` / `git` / `gh` / `tailscale`）はサーバの `PATH` から探す。** launchd などで `PATH` が最小のまま起動するなら、サーバに `PATH` を渡す（`tailscale` は `PATH` に無ければ macOS の GUI 版も試す）。前は `SAI_CLAUDE_BIN` などで 1 つずつ差し替えていたが、`PATH` を 1 つ直せば全部に効くのでやめた（#288）。

| | |
| --- | --- |
| `SAI_TERMINAL` | `0` で tmux への打ち込みを切る。Claude と閉じた Codex は別プロセス、開いている Codex は queue |
| `SAI_APPROVE` | `0` で「返信中の許可・質問に画面から答える」配線（`--mcp-config` + `--permission-prompt-tool`）を付けない |
| `SAI_CODEX_APP_SERVER` | `0` で閉じたCodexのapp-server管理を切り、従来の `codex exec resume` に戻す。既定は有効 |
| `SAI_GH` | `0` で差分ボタンの PR 番号を引かない（既定は引く。SAI で唯一外のネットワークに問い合わせる所）。叩くのは `PATH` の `gh` の `gh pr view` だけで、引けなければ番号が付かないだけ |
| `CODEX_HOME` | Codex のホーム（既定 `~/.codex`）。Codex 自身の変数で、SAI はそれに従うだけ |
| `AGENT_FEED_DEBUG` | `1` で `record.py` の例外をログに残す |

表に無いもの（SAI が自分で付ける・エージェントが渡してくる）: `AGENT_FEED_SKIP`（SAI が一言を作るために回す `claude -p` に付け、`record.py` に自分自身を記録させない）、`SAI_URL` / `SAI_ENTITY`（返信の `claude` に足す MCP サーバに渡す）、`TMUX_PANE` / `CLAUDE_PID`（エージェントが `record.py` に渡してくる）。
