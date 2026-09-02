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
├── feed/
│   ├── record.py        … フックから呼ばれて1行 append する
│   └── test_record.py
└── web/
    ├── serve.py         … 127.0.0.1 専用の HTTP サーバ。集計と API、dist/ の配信
    ├── test_serve.py
    ├── src/             … 画面（React + TypeScript）
    ├── package.json     … pnpm。lint は oxlint、ビルドは Vite
    └── dist/            … `pnpm build` の成果物（コミットしない）
```

配管とサーバは Python 3.9+ の標準ライブラリだけ。画面は pnpm + React + TypeScript + oxlint。

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
cd web && pnpm install && pnpm build && cd ..
python3 web/serve.py            # http://127.0.0.1:8787/
python3 web/serve.py --port 9000 --feed-dir ~/.agent-feed
```

`serve.py` は `web/dist/` を配る。未ビルドなら `/` にその旨が出る。`file://` で開くと fetch が CORS で止まるので、必ずこのサーバ経由で開く。`127.0.0.1` 以外には bind を拒否する。

画面を触るときは `serve.py` を立てたまま `cd web && pnpm dev`。Vite が `/api` を `127.0.0.1:8787` に流す。

```
pnpm lint        # oxlint
pnpm typecheck   # tsc --noEmit
pnpm build       # typecheck してから vite build
```

### 3. 確かめる

- Claude で1ターン回す → `~/.agent-feed/YYYY-MM-DD.jsonl` が1行増え、`session_source` が `payload`
- Codex で1ターン回す → 1行増え、`session_source` が `rollout`（`synth` になるなら下の「Codex のセッションID」を疑う）
- `echo 'not json at all' | python3 feed/record.py; echo $?` → `0` で、行は増えない

テスト:

```
python3 -m unittest feed.test_record web.test_serve
cd web && pnpm lint && pnpm typecheck
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

行ごとに1セッション。新しい順。

| 列 | 出どころ |
| --- | --- |
| 開始 – 終了 | そのセッションの最初と最後の `ts` |
| エージェント | `agent`（色分け） |
| リポジトリ / ブランチ | `repo` / `branch`。途中で変わったら最後の値を出して「+N」 |
| ターン数 | 行数 |
| タイトル | `first_user_text` があればそれ、無ければ最初の `text` の1行目。60文字で切る |
| 印 | `session_source` が `synth` なら「合成」 |

絞り込みはリポジトリ / エージェント / 日付。行をクリックで画面2へ。

### 画面2: セッションの中身

Slack のチャット風。同一セッションの連続した発言（10分以内）は Slack と同じくまとめる。リポジトリ名がチャンネル。3秒ごとに更新するが、サーバが返す `rev` が変わっていなければ state を触らない（= 描き直さない）。タブが隠れている間は止まる。

「フィード」タブは全チャンネルを時系列に流したもの（`/api/feed`）。

### エンドポイント

| | |
| --- | --- |
| `GET /` | ビューア（`web/dist/index.html`） |
| `GET /assets/*` | ビルド成果物。`dist/` の外には出ない |
| `GET /api/sessions?days=7&repo=&agent=&date=` | セッション一覧（集計済み）。`filters` に絞り込み候補も返す |
| `GET /api/sessions/<id>?days=30` | そのセッションの全行 |
| `GET /api/feed?days=3&repo=` | 生の行 |

集計はサーバ側。ファイルは `(mtime, size)` で覚えていて、変わっていなければ再パースしない。1日開きっぱなしにしても重くならないのはこのため。

## 守ること

- **`record.py` は絶対に失敗しない。** 必ず exit 0。フックが落ちるとエージェント本体を止めてしまうので、記録に失敗しても黙って諦める。何が起きたか見たいときは `AGENT_FEED_DEBUG=1` で `~/.agent-feed/record-errors.log` に残る。15秒で自分を殺す保険も入っている
- **本物の Slack には投げない。** 投げ先が会社のワークスペースになるので、個人リポジトリのセッション記録がそこに流れるのは避ける
- **SAI は外に出さない。** `127.0.0.1` 限定。デプロイもホスティングもしない。中身は作業内容そのもの
- **一覧のタイトルに機密が乗りうる。** 仕事のリポジトリのセッションだと issue の内容がそのまま出る。スクリーンショットを撮るときは自分で気をつける

## 環境変数

| | |
| --- | --- |
| `AGENT_FEED_DIR` | 出力先（既定 `~/.agent-feed`）。`record.py` と `serve.py` の両方が見る |
| `AGENT_FEED_DEBUG` | `1` で `record.py` の例外をログに残す |
| `CODEX_HOME` | Codex のホーム（既定 `~/.codex`） |
| `SAI_PORT` | `serve.py` の既定ポート（既定 `8787`） |
| `SAI_VERBOSE` | `1` でアクセスログを出す |
