# SAI — 複数 AI エージェントを跨いだチャット風インターフェース

Claude Code と Codex CLI のターン完了をフックで1本の流れに集めて、**セッション一覧 → セッションの中身**の2画面で眺める。「さっきのあれ、どのセッションでやったんだっけ」を、端末のスクロールバックではなく画面で引けるようにするためのもの。

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

### 1. フックを向ける

**Claude Code** — `~/.claude/settings.json`（全リポジトリ）か `.claude/settings.json`（そのリポジトリだけ）に:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "python3 /absolute/path/to/sai/feed/record.py" } ] }
    ]
  }
}
```

**Codex CLI** — `~/.codex/config.toml` に:

```toml
notify = ["python3", "/absolute/path/to/sai/feed/record.py"]
```

どちらも絶対パスで。`notify` の JSON が「最後の引数」で来るか stdin で来るかは資料によって食い違うので、`record.py` は両方受ける。

### 2. 画面をビルドしてサーバを立てる

```
pnpm install && pnpm build
pnpm start                                   # http://127.0.0.1:8787/
pnpm start -- --port 9000 --feed-dir ~/.agent-feed
```

サーバは `web/dist/` を配る。未ビルドなら `/` にその旨が出る。`file://` で開くと fetch が CORS で止まるので、必ずこのサーバ経由で開く。`127.0.0.1` 以外には bind を拒否する。

画面を触るときはサーバを立てたまま `pnpm dev`。Vite が `/api` を `127.0.0.1:8787` に流す。

```
pnpm lint        # oxlint（web/src, server, shared）
pnpm typecheck   # tsc（web と server の両方）
pnpm test        # node:test（server/）
pnpm test:feed   # python3 -m unittest（feed/）
pnpm build       # typecheck してから vite build
```

### 3. 確かめる

- Claude で1ターン回す → `~/.agent-feed/YYYY-MM-DD.jsonl` が1行増え、`session_source` が `payload`
- Codex で1ターン回す → 1行増え、`session_source` が `rollout`（`synth` になるなら下の「Codex のセッションID」を疑う）
- `echo 'not json at all' | python3 feed/record.py; echo $?` → `0` で、行は増えない

テスト:

```
pnpm test && pnpm test:feed && pnpm lint && pnpm typecheck
```

## データ

### 受け口は JSONL 1本だけ

```
Claude Code ──[Stop hook]──┐
                           ├──> ~/.agent-feed/YYYY-MM-DD.jsonl ──> SAI
Codex CLI ──[notify]───────┘
```

フックがやるのは1行 append するだけ。集計も表示もしない。記録が壊れても表示が壊れるだけで済むし、表示を作り変えても記録側は触らずに済む。

### 1行の形

```json
{
  "ts": "2026-09-02T12:45:04+09:00",
  "agent": "claude",
  "repo": "kanban",
  "branch": "20260902",
  "session": "sess-abc",
  "session_source": "payload",
  "cwd": "/home/user/kanban",
  "event": "Stop",
  "text": "背中のメニューを出した。ワンハンドロウ 10kg×10×3。",
  "first_user_text": "背中のメニューを出して"
}
```

| フィールド | |
| --- | --- |
| `agent` | `claude` / `codex` / `unknown` |
| `session_source` | `payload`（ペイロードから）/ `rollout`（Codex のファイルから）/ `synth`（時間で合成）。一覧の信頼度がここで分かる |
| `text` | 最後のアシスタント発話。Claude は `transcript_path` の末尾から、Codex は `last-assistant-message`。2,000文字で切る |
| `first_user_text` | 最初のユーザー発話。一覧のタイトルに使う。300文字で切る |

日付は `Asia/Tokyo` で切る。

`first_user_text` は1行目だけでなく**毎行**に載せている。集計は「一番古い行の値」を使うので結果は同じで、`days` で切った窓の外にセッションの1行目が落ちてもタイトルが消えない。

### 履歴はリポジトリに入れない

`~/.agent-feed/` はリポジトリの外。作業内容の断片が入るので、うっかりコミットされない場所に置く。`.gitignore` の `*.jsonl` / `.agent-feed/` / `sessions/` は、手元にコピーしたときの保険として最初のコミットから入っている。

## 先に確かめた前提

**素朴に作ると動かない点が2つある。**

### 1. 「セッション終了」は掴めない

- Claude Code の `SessionEnd` は `/clear` のときしか発火しない
- Codex の `notify` はイベントが `agent-turn-complete` の1種類だけ

→ 共通して掴めるのは「ターン完了」だけなので、Claude 側も `Stop` フックを使う。1行 = 1ターン。セッションは後段でまとめる。

### 2. Codex の notify ペイロードにセッションIDが無い

Claude の `Stop` は `session_id` を stdin の JSON に含むが、Codex の `agent-turn-complete` には無い。

→ **記録時に、cwd が一致する直近の rollout ファイル（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）からセッションIDを引く。** `session_index.jsonl` は壊れていることがある（`codex resume --all` が「No sessions yet」になる既知の問題）ので、索引ではなくファイル名から直接取る。

それも取れなかったときは `(repo, cwd, agent)` が同じで前の行から**30分以内**なら同じセッションとみなし、ID は `synth-<repo>-<開始時刻>` にする。合成であることが後から分かるよう `session_source` を `synth` にする。一覧では「合成」の印が付く。

## SAI（画面）

### 画面1: セッション一覧

行ごとに1エンティティ = **(セッション, リポジトリ)** の組。新しい順。同じセッションIDが別リポジトリに現れても（IDの衝突や cwd の移動）、リポジトリごとに別の行になる。IDは `<セッション>@<リポジトリ>`。

| 列 | 出どころ |
| --- | --- |
| 開始 – 終了 | そのエンティティの最初と最後の `ts` |
| エージェント | `agent`（色分け） |
| リポジトリ / ブランチ | `repo` / `branch`。ブランチが途中で変わったら最後の値を出して「+N」 |
| ターン数 | 行数 |
| タイトル | `first_user_text` があればそれ、無ければ最初の `text` の1行目。60文字で切る |
| 印 | `session_source` が `synth` なら「合成」 |

絞り込みはリポジトリ / エージェント / 日付。行をクリックで画面2へ。

### 画面2: セッションの中身

Slack のチャット風。同一セッションの連続した発言（10分以内）は Slack と同じくまとめる。リポジトリ名がチャンネル。3秒ごとに更新するが、サーバが返す `rev` が変わっていなければ state を触らない（= 描き直さない）。タブが隠れている間は止まる。

下の入力欄から**そのセッションに続きの指示を送れる**（Enter で送信、Shift+Enter で改行）。サーバが `cwd` でセッションを非対話モードの CLI で再開して1ターン回す:

| エージェント | コマンド |
| --- | --- |
| Claude Code | `claude -p --resume <session> "<text>"` |
| Codex CLI | `codex exec resume <session> "<text>"` |

回したターンが完了すれば既存のフック（Stop / notify）が動いて JSONL に1行増えるので、返信の結果は今のポーリングでそのまま画面に流れてくる。送信直後は「送信中…」の仮バブルが出て、行が増えたら消える。`session_source` が `synth` のセッション、`unknown-<日付>` に丸められたセッション、`agent` が `unknown` のセッションは ID が合成なので再開できず、入力欄の代わりにその旨が出る。

「フィード」タブは全チャンネルを時系列に流したもの（`/api/feed`）。

### エンドポイント

| | |
| --- | --- |
| `GET /` | ビューア（`web/dist/index.html`） |
| `GET /assets/*` | ビルド成果物。`dist/` の外には出ない |
| `GET /api/sessions?days=7&repo=&agent=&date=` | セッション一覧（集計済み）。`filters` に絞り込み候補も返す |
| `GET /api/sessions/<id>?days=30` | そのエンティティの全行。`<id>` は `<セッション>@<リポジトリ>` |
| `POST /api/sessions/<id>/reply?days=90` | body `{ "text": "..." }`。そのセッションを `cwd` で再開して1ターン回すのを投げっぱなしにし、`202` を返す。合成 ID は `400`、進行中は `409`、別オリジンは `403` |
| `GET /api/feed?days=3&repo=` | 生の行 |

返信の実行は `server/runner.ts`。`claude` / `codex` は `detached` で起動して待たず、stdout/stderr は `~/.agent-feed/reply.log` に追記する（うまく動かないときはここを見る）。同じエンティティに同時に2本は走らせない。

集計はサーバ側（`server/aggregate.ts`）。エンティティのキー（`<セッション>@<リポジトリ>`、セッションが取れない行は `unknown-<日付>`）は `shared/entity.ts` にあり、サーバの集計と画面のリンクが同じ関数を使う。ファイルは `(mtime, size)` で覚えていて、変わっていなければ再パースしない（`server/store.ts`）。1日開きっぱなしにしても重くならないのはこのため。

レスポンスの形は `shared/types.ts` に1つだけ書いてあり、サーバの集計と画面の受け取りが同じ型を見る。フィールドを足すときはそこに足すと、片方だけ忘れたときに `pnpm typecheck` で止まる。

## 守ること

- **`record.py` は絶対に失敗しない。** 必ず exit 0。フックが落ちるとエージェント本体を止めてしまうので、記録に失敗しても黙って諦める。何が起きたか見たいときは `AGENT_FEED_DEBUG=1` で `~/.agent-feed/record-errors.log` に残る。15秒で自分を殺す保険も入っている
- **本物の Slack には投げない。** 投げ先が会社のワークスペースになるので、個人リポジトリのセッション記録がそこに流れるのは避ける
- **SAI は外に出さない。** `127.0.0.1` 限定。デプロイもホスティングもしない。中身は作業内容そのもの
- **ブラウザからコマンドが走る。** 返信は `claude` / `codex` を任意の `cwd` で起動する。ローカルで開いている別サイトからの CSRF でエージェントを走らせないよう、`POST` は `Origin` / `Sec-Fetch-Site` が同一オリジンでなければ `403`（どちらも無い curl などブラウザ以外は通す）。この確認は外さない。権限のバイパス（`--dangerously-skip-permissions` など）も付けない
- **一覧のタイトルに機密が乗りうる。** 仕事のリポジトリのセッションだと issue の内容がそのまま出る。スクリーンショットを撮るときは自分で気をつける

## 環境変数

| | |
| --- | --- |
| `AGENT_FEED_DIR` | 出力先（既定 `~/.agent-feed`）。`record.py` とサーバの両方が見る |
| `AGENT_FEED_DEBUG` | `1` で `record.py` の例外をログに残す |
| `CODEX_HOME` | Codex のホーム（既定 `~/.codex`） |
| `SAI_PORT` | サーバの既定ポート（既定 `8787`） |
| `SAI_CLAUDE_BIN` | 返信で起動する `claude` の実行ファイル（既定は PATH の `claude`）。launchd などで PATH が最小のときに |
| `SAI_CODEX_BIN` | 同じく `codex` |
