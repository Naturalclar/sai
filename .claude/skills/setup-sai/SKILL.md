---
name: setup-sai
description: clone した SAI を使える状態にする。フック（Claude）/ notify（Codex）/ プラグイン（OpenCode）/ ステータスライン（使用率）の向け先、ビルド、動作確認までを、既存の設定を壊さずに行う。点検だけもできる。ユーザーが「SAI をセットアップして」「フックを設定して」「記録が来ていないか見て」「使用率が出ない」「statusLine を設定して」「set up sai」「sai doctor」と言ったときに使う。
---

# setup-sai

clone した SAI を「1 ターン回すと画面に出る」ところまで持っていく。**設定を書くのが目的ではなく、記録が届くのが目的**なので、まず結果から見る。

**この skill の一番の仕事は、既にある設定を壊さないこと。** フックも `notify` も、SAI 以外の物が既に入っているのが普通で、上書きすると黙って別の物が止まる。**読む → 差分を見せる → 確認を取ってから書く**。確認なしにファイルを書き換えない。

## 0. 先に結果を見る（設定を辿る前に）

設定を追いかけるより、**書かれた行を見るほうが速くて確実**。

```sh
# 日付のファイルだけを見る。*.jsonl だと digest.jsonl（一言。行の形が違う）を拾って
# agent も v も None になり、動いているのに「壊れている」と読み違える
ls -t ~/.agent-feed/20??-??-??*.jsonl 2>/dev/null | head -1 | xargs tail -1 |
  python3 -c "import json,sys; r=json.load(sys.stdin); print(r.get('ts'), r.get('agent'), 'v=%s' % r.get('v'), r.get('repo'))"
```

| 出たもの | 意味 | 次に見るところ |
| --- | --- | --- |
| 数分前の行があり `v` が最新 | **もう動いている。** 設定は触らない | 6（ビルドと画面）だけ確かめる |
| 行はあるが `v` が古い | フックが**古い checkout** の `record.py` を指している | 3 で向き先を直す（足さない） |
| ファイルが無い / 何日も古い | まだ届いていない | 1 から順に |
| 使っているはずのエージェントの行だけ無い | そのエージェントの配線だけ抜けている | そのエージェントの節へ |

最新の版は `feed/record.py` と `shared/types.ts` の `RECORD_VERSION`（この 2 つは必ず同じ値）。

```sh
grep -o 'RECORD_VERSION = [0-9]*' feed/record.py shared/types.ts
```

**Claude の使用率だけは行とは別の口**（ステータスライン）から来るので、ここでは分からない。「割合が出ない」は 3.3 を見る。

## 1. どの checkout を設定するか

```sh
git rev-parse --show-toplevel
```

worktree を複数持っているなら**どれを記録に使うかは人が決める**（`dev-*` で作業していても、フックは `main` を指しておくのが普通）。勝手に今いる worktree に向け直さない。決まった絶対パスを以下 `$SAI_HOME` と呼ぶ。

## 2. 前提

| 見るもの | 要る値 | 外れたときに起きること |
| --- | --- | --- |
| `node -v` | 22.18+（`package.json` の `engines`） | `pnpm start` / `pnpm test` が `ERR_UNKNOWN_FILE_EXTENSION` で落ちる。asdf では `ASDF_NODEJS_VERSION=22.x` を前置しないと古い版が選ばれる |
| `pnpm -v` | 12 系 | 設定は `pnpm-workspace.yaml`。無いと install かビルドが落ちる |
| `python3 -V` | 3.9+ | `record.py` は標準ライブラリのみ |

`tmux` と `gh` は無くてもよい（端末への打ち込みと、差分ボタンの PR 番号が出ないだけ）。

## 3. Claude Code の設定（**上書きしない**）

`~/.claude/settings.json` の中に**別々の 2 つ**がある。どちらも SAI 以外の物が既に入っていることが多い。

| | 何のため | 枠 |
| --- | --- | --- |
| `hooks`（3.1 / 3.2） | ターンを記録する（画面に出る） | イベントごとの**配列**。足せる |
| `statusLine`（3.3） | Claude の使用率を出す（任意） | **1 つだけ**。取り合いになる |

同じファイルなので、両方直すなら**控えは 1 回でよい**（3.2 の 1）。

見るのは `~/.claude/settings.json`（全体）と、記録したいリポジトリの `.claude/settings.json`（そこだけ）。**両方に入っていると 1 ターンが 2 行になる**ので、必ず両方見る。

### 3.1 いま届いているか

フックのコマンドは `python3 "$SAI_HOME/feed/record.py"` の直書きとは限らない。**PATH に置いたラッパー**（`sai-record` のような、中で `record.py` を呼ぶもの）を指していることがあるので、**コマンド名だけで判断せず中身を読む**:

```sh
python3 - <<'PY'
import json, os, shutil
def reaches(cmd):
    if 'record.py' in cmd: return cmd
    exe = (cmd.split() or [''])[0]
    p = shutil.which(exe)
    if not p: return None
    try: body = open(p, encoding='utf-8', errors='replace').read()
    except Exception: return None
    return f'{p} 経由' if 'record.py' in body else None
for label, path in [('user', os.path.expanduser('~/.claude/settings.json')), ('project', '.claude/settings.json')]:
    try: hooks = (json.load(open(path)) or {}).get('hooks') or {}
    except Exception: print(f'{label}: {path} は無い / 読めない'); continue
    hits = [(e, g.get('matcher',''), h.get('command',''), reaches(h.get('command','')))
            for e, gs in hooks.items() for g in gs for h in g.get('hooks', []) if reaches(h.get('command',''))]
    print(f'{label}: {path} → record.py に届くフック {len(hits)} 件')
    for e, m, c, v in hits: print(f'   {e:18} matcher={m!r} {c!r} -> {v}')
PY
```

- **両方に出たら二重掛け。** 片方を外すことを勧める（どちらを残すかは人が決める）
- **ラッパー経由なら、その向き先を確かめる。** `SAI_HOME` の既定はラッパーごとに違うので**推測せずスクリプトを読む**（README の例は `~/src/sai`、実在のラッパーは `~/.ghq/.../sai.git/main` だった）。`SAI_HOME` は**エージェントの環境**で解決される（このシェルで未設定でも、シェルの rc や `settings.json` の `env` で入っていることがある）ので、「このシェルで空だから壊れている」とは判断しない。最終確認は 0 の行の `v`
- 届いているなら**足さない**。向き先だけ直す

### 3.2 足すとき

イベントごとの配列に**足す**。既存の塊は触らない。matcher 付きの塊は別物なので、matcher 無しの塊に混ぜない。

必要なフックと matcher は README「1. フックを向ける」の表が正本。`Stop` だけでもターンは記録され、残りは待ち・入力の行を出すためのもの。

書く前に:

1. `cp ~/.claude/settings.json ~/.claude/settings.json.bak-$(date +%Y%m%d%H%M%S)` で控える
2. **足したあとの JSON の差分を出して見せる**（既存のフックが全部残っていることを人が確認できる形で）
3. 確認が取れてから書く。書いたあと `python3 -m json.tool` で読めることを確かめる

### 3.3 使用率のステータスライン（任意。**1 つしか持てない**）

Claude の 5 時間・週の使用率をヘッダに出すための口（#250）。**要らなければ飛ばしてよい**（設定しなければ、上限に当たったときだけ「上限中」と出る）。

**割合はここからしか手元に来ない。** transcript の `quotaLimits` は弾かれたときにしか載らず、`claude` CLI に `usage` のサブコマンドも無い（TUI の `/usage` が叩く API は OAuth のトークンが要るので SAI は使わない）。

まず**結果を見る**（フックと同じ順序）。判定はサーバと同じ規則にする（`server/usage.ts` の `isClaudeUsageFile`、`shared/usage.ts` の `STATUS_MAX_AGE_MS`）:

```sh
python3 - <<'PY'
import json, os, re, time
feed = os.environ.get('AGENT_FEED_DIR') or os.path.expanduser('~/.agent-feed')
MAX_AGE = 8 * 86400  # shared/usage.ts の STATUS_MAX_AGE_MS。これより古いとサーバが捨てる
try: names = sorted(n for n in os.listdir(feed) if re.fullmatch(r'usage-claude(\.[^/]+)?\.json', n))
except OSError: names = []
if not names: print(f'{feed}: usage-claude*.json が無い → statusLine 未設定か、まだ 1 回も描画されていない')
now = time.time()
for n in names:
    try: d = json.load(open(os.path.join(feed, n)))
    except Exception as e: print(f'{n}: 読めない ({e})'); continue
    age = now - (time.mktime(time.strptime(d.get('ts','')[:19], '%Y-%m-%dT%H:%M:%S')) if d.get('ts') else 0)
    limits = d.get('rate_limits') or {}
    windows = {k: v.get('used_percentage') for k, v in limits.items() if isinstance(v, dict)}
    print(f'{n}: ts={d.get("ts")} ({age/3600:.1f}h 前{"、古すぎる" if age > MAX_AGE else ""}) windows={windows or "空（subscription でない？）"}')
PY
```

**ファイルがあって新しく、`windows` に数字が入っていれば、もう出ている。** `statusLine` は触らない。

無ければ、いまの `statusLine` を読む（フックと同じで、**コマンド名だけで判断せず中身を読む**。ラッパー経由で届いていることがある）:

```sh
python3 - <<'PY'
import json, os, shutil
def reaches(cmd, needle):
    if not cmd: return None
    if needle in cmd: return cmd
    exe = (cmd.split() or [''])[0]
    p = shutil.which(exe)
    if not p: return None
    try: body = open(p, encoding='utf-8', errors='replace').read()
    except Exception: return None
    return f'{p} 経由' if needle in body else None
path = os.path.expanduser('~/.claude/settings.json')
try: sl = (json.load(open(path)) or {}).get('statusLine')
except Exception as e: print(f'{path} は無い / 読めない ({e})'); raise SystemExit
if not sl: print('statusLine: 未設定 → SAI の割合は永久に出ない'); raise SystemExit
cmd = sl.get('command', '') if isinstance(sl, dict) else str(sl)
print(f'statusLine: {cmd!r}')
print('  statusline.py に届くか:', reaches(cmd, 'statusline.py') or '届かない → 別のものに取られている')
PY
```

| いまの値 | どうするか |
| --- | --- |
| 未設定 | `{"type":"command","command":"python3 \"$SAI_HOME/feed/statusline.py\""}` を提案する。**stdout がそのままステータスラインになる**ことを伝える（`statusline.py` は `Opus 5 · 5時間 43% · 週 71%` のような 1 行を出す。何も出さないとステータスラインが空になる） |
| 既に `statusline.py` に届いている | 向き先だけ確かめる（フックと同じで、古い checkout を指していることがある） |
| **別のものが入っている** | **置き換えない。** いまの値を見せて、README「4. Claude の使用率を出す」の `sai-statusline` ラッパー（同じ JSON を SAI にも配り、**今までの表示をそのまま出す**）に畳む案を出す。ラッパーを置くかは人が決める |

**取れないのが正しい場合がある。** `rate_limits` が載るのは **subscription のときだけ**で、API キー利用や gateway 経由では載らない（gateway は `spend_limit`）。上のコマンドで `windows` が空なら設定は合っていて、これ以上できることは無い。**壊れていると報告しない。**

## 4. Codex CLI の `notify`（**1 つしか持てない**）

```sh
grep -n '^notify' ~/.codex/config.toml
```

| いまの値 | どうするか |
| --- | --- |
| 無い | `notify = ["python3", "<$SAI_HOME>/feed/record.py"]`（**絶対パス**。`notify` はシェルを通らないので `$SAI_HOME` は展開されない） |
| 既に SAI を指している | 向き先だけ確かめる |
| **別の受け手が入っている** | **置き換えない。** 値をそのまま人に見せ、README のラッパー（受け手を順に呼び、失敗しても他を止めず、常に exit 0）に畳む案を出す |

相手側が「次の受け手」を持てる作り（`--previous-notify` のような引数）のこともあるので、**ラッパーを作る前に、いまの値が何なのかを人に読ませる**。

## 5. OpenCode のプラグイン

フックの仕組みが無いので、`feed/opencode/sai.js` を置き場に symlink する（全体は `~/.config/opencode/plugin/`、そのプロジェクトだけなら `.opencode/plugin/`）。**symlink なら `SAI_HOME` が無くても隣から `record.py` を辿る**（コピーしたなら `SAI_HOME` が要る）。既に同名のファイルがあれば上書きせず報告する。

## 6. ビルドして立てる

```sh
pnpm install && pnpm build      # build は typecheck 込み
```

`pnpm start` は **人に任せる**（`sync-main` が「止まっているサーバは起動しない」としているのと同じで、止めてあるのはその人の意図かもしれない）。既に動いているかは:

```sh
lsof -nP -iTCP:8787 -sTCP:LISTEN -t     # ポートは SAI_PORT / --port で変わる
curl -sS -m 5 http://127.0.0.1:8787/api/sessions?days=1 >/dev/null && echo ok
```

## 7. 確かめる

```sh
echo 'not json at all' | python3 feed/record.py; echo $?   # 0 で、行は増えない
```

そのうえで**実際に 1 ターン回してもらう**（設定を書いただけで「できました」と言わない）。エージェントごとに、0 のコマンドで新しい行を見る:

| | `agent` | `session_source` |
| --- | --- | --- |
| Claude Code | `claude` | `payload` |
| Codex CLI | `codex` | `rollout`（`synth` なら `docs/design-notes.md` を疑う） |
| OpenCode | `opencode` | `payload` |

`v` が `RECORD_VERSION` と一致していること。画面（`http://127.0.0.1:8787/`）にそのセッションが出れば完了。

**3.3 を設定したなら**、そちらも見る。ステータスラインは**ターンを回さなくても**、Claude Code を開いて描画されれば書かれる:

```sh
curl -sS -m 5 http://127.0.0.1:8787/api/usage    # claude.primary に割合が載る
```

ヘッダの使用量に `Claude NN%` が出れば完了。載らないときは 3.3 の表（未設定 / 取られている / 古い / subscription でない）に戻る。

## 点検だけ（doctor）

「記録が来ていない」「設定が合っているか見て」と言われたときは、**0 → 3.1 → 4 → 5 を読むだけ**で回して報告する。書き込みはしない。よく出る答え:

- 向き先が古い / 消えた checkout（画面のヘッダにも「記録側の `record.py` が古い」が出る）
- ユーザー設定とプロジェクト設定の二重掛け（1 ターンが 2 行になる）
- `notify` が別の受け手に取られている（Codex の行だけ来ない）
- `AGENT_FEED_HOST` を設定したので書き込み先が `YYYY-MM-DD.<host>.jsonl` に分かれただけ（壊れていない）

**「Claude の使用率だけ出ない」は 3.3 を読むだけ**で、答えは 4 通り。**最後の 1 つは壊れていない**ので、そう報告する:

| 見えること | 答え |
| --- | --- |
| `statusLine` が未設定 | 設定していないだけ。任意の機能 |
| `statusLine` が別のものを指している | 取られている。ラッパーで共存できる |
| ファイルはあるが 8 日より古い | Claude をしばらく動かしていない（`STATUS_MAX_AGE_MS`） |
| ファイルはあるが `windows` が空 | **subscription ではない**（API キー / gateway）。設定は合っていて、これ以上できることは無い |

## 報告

- いま届いているか（0 で見た一番新しい行）。エージェントごとに来ている / 来ていない
- 触ったファイルと、**何を足して何を残したか**。控え（`.bak-*`）の場所
- 触らなかったもの（既に入っていた、人の判断待ち）とその理由
- 人がやること（1 ターン回す、`pnpm start` する、`notify` / `statusLine` のラッパーを置くか決める）
- 使用率を設定したなら、出るようになったか（**subscription でなくて出ないなら、それは正常**と書く）

## やらないこと

- 確認なしに `settings.json` / `config.toml` を書き換える。既存のフック・`notify`・**`statusLine`** を消す
- ラッパースクリプトを人の dotfiles に勝手に置く（`sai-codex-notify` / `sai-statusline` とも。**提案までにして、置くかは人が決める**）
- `context_window`（セッションごとの文脈の残り）を扱う。使用量（口座ごと）とは別の話で、#250 が範囲外にしたまま
- サーバを勝手に常駐させる、`~/.agent-feed` の中身を触る
- どの worktree を記録に使うかを勝手に決める
- tailnet の設定（`tailscale-serve` が別にある）、`main` の更新（`sync-main` が別にある）
