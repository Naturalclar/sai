# ローカル LLM で使う

Claude / OpenAI のクラウドに出さず、手元のモデル（Ollama / LM Studio など）で SAI を回すための設定。セットアップは [README](../README.md)。

**SAI 自身は推論しない。** 推論はエージェント CLI かローカルのサーバの仕事で、SAI は「見る側」のまま。なので**やることは CLI の向き先を変えるだけ**で、SAI のコードは触らない。

以下は実際に Ollama（`qwen3:8b`）で通したもの。通らなかったことも最後に書いてある。

## OpenCode

**ここが一番素直**（プロバイダの差し替えが素の作りに入っていて、SAI からの返信も同じモデルで回る）。プラグインの置き方は [README](../README.md)。

プロジェクトの `opencode.json`（全体なら `~/.config/opencode/opencode.json`）に Ollama を足して既定のモデルにする:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": { "baseURL": "http://127.0.0.1:11434/v1" },
      "models": { "qwen3:8b": { "name": "Qwen3 8B" } }
    }
  },
  "model": "ollama/qwen3:8b"
}
```

これで回したターンは、プラグインが入っていればそのまま記録される:

```json
{"agent": "opencode", "event": "session.idle", "session_source": "payload", "model": "ollama/qwen3:8b", …}
```

`model` は `provider/model` の形でそのまま載る。セッションIDはイベントに載っているので `session_source` は常に `payload`（Codex のような rollout 引きも合成も要らない）。

### SAI からの返信

**Codex と違って、返信でモデルを指定し直す必要が無い**。端末（tmux）で開いていればその TUI に打ち込むだけだし、閉じていれば `opencode run -s <session>` で再開し、どちらも `opencode.json` の設定をそのまま使う。`SAI_OPENCODE_ARGS` で `--agent build` のような引数を足せる。

### 分かっていること

- 許可を SAI の画面から答える口は無い（`--permission-prompt-tool` に当たるものが無い）。`permission.asked` は待ちの行として出るだけで、答えるのは端末側
- **`opencode run`（閉じたセッションへの返信）は許可を自動で拒否する**（`permission.replied` の `reply: "reject"` を実測）。拒否されたツールで終わったターンは本文が無いので、チャットには「何が拒否されたか」を出す（#273）。許可が要る作業は端末で開いてから返信する。`--auto` は SAI からは付けない（`SAI_OPENCODE_ARGS` で運用者が渡すのは可）
- 一言コメント（digest）は SAI 側の設定（`SAI_DIGEST_PROVIDER=openai`）なので、エージェントが何であっても同じローカルのモデルで作れる

## Codex CLI

### 新しいセッション（端末で始める）

```
codex exec --oss --local-provider=ollama -m qwen3:8b "…"
codex --oss --local-provider=ollama -m qwen3:8b            # 対話で始めるとき
```

`--local-provider` を省くと `No default OSS provider configured` で止まる（`lmstudio` か `ollama`）。毎回書きたくなければ `~/.codex/config.toml` に `oss_provider` を置く。

これで回したターンは、`notify` が向いていればそのまま記録される:

```json
{"agent": "codex", "event": "agent-turn-complete", "session_source": "rollout", "model": "qwen3:8b", …}
```

`model` にローカルのモデル名がそのまま載る。`session_source` は `rollout` になる（セッションIDの解決はモデルに依らない）。

### SAI からの返信（ここが違う）

`SAI_CODEX_APP_SERVER=0` の従来経路は `codex exec resume` を使うが、**`resume` は `--oss` と `--local-provider` を受け付けない**:

```
$ codex exec resume --oss … <id> -- "…"
error: unexpected argument '--oss' found
```

`resume` が受けるのは `-m/--model` と `-c key=value`。なので**設定か環境変数で渡す**:

```
# どちらか。config.toml に置けば端末からの起動にも効く
~/.codex/config.toml に model_provider と model を書く

# サーバを立てるシェルで渡す（SAI からの返信にだけ効く）
SAI_CODEX_APP_SERVER_ARGS='-c model_provider=ollama -c model=qwen3:8b' pnpm start
```

`SAI_CODEX_APP_SERVER_ARGS` は `server/runner.ts` の `splitArgs()` がシェル風に割り、長寿命の `codex app-server --stdio` に渡す。この形で画面から返信するとローカルモデルで回る。従来の `exec resume` に戻す場合だけ `SAI_CODEX_ARGS` を使う。

セッションごとのモデル（チャット見出しの `ModelPicker`）は `-m` として渡るので **`resume` でも効く**。`model_provider` だけ設定に置いて、モデルはセッションごとに選ぶ、という使い方ができる。モデル名の `:` は通る（`shared/meta.ts` の `META_MODEL_RE` が `.` `_` `:` `/` `-` `[` `]` を許す）。

## Claude Code

`ANTHROPIC_BASE_URL` を Anthropic 互換のプロキシ（LiteLLM など）に向ける。

```
ANTHROPIC_BASE_URL=http://127.0.0.1:4000 pnpm start
```

**`server/runner.ts` の spawn は `env` を渡していない**ので、子プロセスはサーバの環境をそのまま継ぐ。つまり `pnpm start` したシェルに置けば、画面からの返信（`claude -p --resume`）にも届く。

`claude` が実際にこの変数を見ることは確認済み（偽の受け口を立てて `ANTHROPIC_BASE_URL` を向けると `POST /v1/messages` が届く）。

## 一言コメント（digest）

**実装済み。** `claude` バイナリを使わず、OpenAI 互換の `/chat/completions` を直接叩ける:

```
SAI_DIGEST=1 SAI_DIGEST_PROVIDER=openai SAI_DIGEST_URL=http://127.0.0.1:11434/v1 SAI_DIGEST_MODEL=qwen3:8b pnpm start
```

詳しくは [docs/screen.md](screen.md) の「一言コメント」。`<think>…</think>` を返すモデル（qwen3 など）は落としてから使う。

## 端末（tmux）に打ち込む経路

返信先が tmux のペインで開いていれば、SAI は CLI を起動せずそのペインに打ち込む（[docs/screen.md](screen.md)）。**この経路はモデルの向き先に関係ない** — 打ち込んだ先の CLI が既にローカルに向いていれば、そのまま回る。`SAI_CODEX_ARGS` / `ANTHROPIC_BASE_URL` はこの経路では使われない（渡す先が無い）。

## 分かっていないこと

- **Anthropic 互換プロキシ越しの Claude Code**。環境変数が届くところまでは確かめたが、プロキシがローカルモデルで返す応答を Claude Code が受け付けるか、`--permission-prompt-tool`（画面から許可に答える配線）がその先でも動くかは未確認。手元にプロキシが無いため
- **`--oss` で `notify` の形が変わるか**。`qwen3:8b` で 1 ターン回した限り今までどおりだった（`agent-turn-complete`、`input-messages`、`last-assistant-message`）
- **`is_codex_internal_turn()` がローカルモデルでも効くか**。`codex exec` で 1 ターン回した範囲では内部ターンの漏れは無かった（行は 1 本だけ）。ただし `exec` はタイトル生成を呼ばないので、対話で始めたときは別に確かめる必要がある
