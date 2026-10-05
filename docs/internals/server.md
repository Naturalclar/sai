# server の仕組み

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/server.md](../history/server.md)。

## 骨組み（main.ts / createApp）

- `server/` は node:http 直書きで依存ゼロ。
- `main.ts` は引数処理と bind 先チェックだけ。ルーティングは `createApp(store, distDir)` にあり、テストはこれを直接叩く。

## 終わり方（shutdown）

C-c / SIGTERM では必ず終わる（#296。`main.ts` の `shutdown()`）。

- `server.close()` は listen を先に落とすが、コールバックは接続が全部閉じてから呼ばれる。そこで `closeIdleConnections()` を続けて呼び、残るものは `CLOSE_ALL_MS`（1 秒）で `closeAllConnections()`、それでも抜けなければ `FORCE_EXIT_MS`（3 秒）で諦めて終わる（タイマーは `unref()`）。
- 2 回目の C-c はすぐ終わる。
- 抜けられないのは「リクエストを最後まで送っていない接続」（ブラウザの先読み・送信途中）。ポーリングする keep-alive もアイドルの keep-alive も `close()` が自分で切る。
- 返信の子は別の pgid で detached なので巻き込まない（次のサーバが `replying.json` から引き取る）。
- `createApp()` の戻りの `dispose()` を、`shutdown()` の `onStop` が 1 回目の C-c の頭で 1 度だけ呼ぶ。接続が閉じるのを待つ前なので、`FORCE_EXIT_MS` で諦める筋でも通る。

### SAI が起こした `opencode serve` の扱い

- ターンを回していなければ落とす（#457）。
- 回しているときは落とさずに次のサーバへ渡す（#440）。`opencode-serve.json` に pid・待ち受け先・鍵・回しているターンを書き（立った時点で書くので、SAI が落ちても引き取れる）、次の `OpencodeServer` が pid が生きていれば引き取ってターンを処理中として戻す。待ち受け先はそのファイルから読む。
- serve は別の pgid で起こし（C-c の SIGINT を受けない）、出力は `opencode-serve.log` に書かせる。
- `codex app-server --stdio` は stdin で繋いでいるので引き取れない。親が死ぬと stdin のパイプが閉じて自分で終わるので、`dispose()` でも触らない。

## 行の読み込み（store.ts）

- 日付ファイルを `(mtime, size)` で覚えて、変わらなければ再パースしない。そのシグネチャのハッシュを `rev` として返す。
- 読む先は日付から組み立てず、`readdir` して `feedFiles()` で拾う（#113）。`YYYY-MM-DD.jsonl` に加えて、マシンごとに分けた `YYYY-MM-DD.<host>.jsonl` も全部読む。並びは日付 → `host` 名で固定し、行は `ts` で並べ直す。

## 本文の検索（rows/search.ts）

- `server/rows/search.ts` の `searchRows()`（#230。`GET /api/search?q=&days=90`）。
- 索引は持たず、`store.rows()` が持っているパース済みの行を舐めるだけ。
- 新しい順に `SEARCH_LIMIT`（100）まで。
- 当たりの判定と抜粋は `shared/search.ts` を画面と共用する。

## 使用量（local/usage.ts）

`GET /api/usage` は `server/local/usage.ts` の `UsageStore` がローカルのファイルを読むだけ（#216 / #250）。

### Claude

- 割合（`feed/statusline.py` が書く `<feed dir>/usage-claude[.<host>].json`）と「いま上限に当たっているか」（`~/.claude/projects/*/*.jsonl` の `quotaLimits`）を `mergeClaudeUsage()` で重ねる。片方だけのことがあるので、`ClaudeUsage.primary` / `limited` はそれぞれ任意。
- ステータスラインの割合は、枠の `resets_at` を過ぎたものと、`STATUS_MAX_AGE_MS`（8 日）より古いファイルを捨てる。
- 書く側（`feed/statusline.py`）も同じ条件で、`resets_at` を過ぎた窓は書かない（`live_windows()`。全部過ぎていればファイルに触らない）。置いてある記録のほうが新しければ上書きしない（`windows_to_write()`。`ts` が今より先で、`NEWER_TRUST_SECONDS`（5 分）以内で、生きている窓が 1 つはあるときだけ。読めない `ts`・先すぎる `ts`・窓が全部戻った記録は上書きする）。期限切れの境界（`resets_at <= now`）は `feed/test_statusline.py` と `shared/usage.test.ts` に同じ形で置く（#683）。
- 書く窓は `windows_to_write()` が置いてある記録と突き合わせて決める（#689）。`merge_windows()` は窓ごとに新しいほうを残す: `resets_at` の差が `SAME_WINDOW_SECONDS`（60 秒）以内なら同じ窓で割合の高いほう、先へ進んでいれば新しい窓で来たほう、手前なら置いてあるほう。来なかった窓は持ち越す（`resets_at` の無い窓は持ち越さない）。**置いてあるものと同じになったら書かない**ので、`ts` は割合が最後に変わった時刻になる。窓ごとに `changed_at`（その窓の割合が最後に変わった時刻。読む側は見ない。無ければ記録の `ts`）を持ち、`KEEP_SECONDS`（24 時間）より長く変わっていない窓は、同じ窓の低い値でも置き直す。

### Codex

- rollout は `tailLines()` で末尾 64KB だけ読む。
- 候補は mtime の新しい順に数件。開きっぱなしのセッションは古い日付のディレクトリに追記され続けるので、日付の新しさで打ち切らない。

### 共通

- パスはホームと `CODEX_HOME` から固定で組み立て、リクエストからは受けない。
- `UsageStore` のコンストラクタは置き場（codex / claude / feed dir）に既定値を持たない。本番の組み立ては `createApp` の既定値にだけある。
- 3 秒のポーリングには乗せず 30 秒キャッシュ。
- 行の読み方（`parseCodexUsage` / `parseClaudeUsage`）と言い換え（`resetLabel` / `windowLabel` / `usageLevel`）は `shared/usage.ts`（`shared/usage.test.ts`）。

### 画面

- ヘッダの `UsageChip`。`useUsage.ts` が開いたとき・タブに戻ったとき・パネルを開いたときだけ取る。取れなければ何も出さない。
- チップに何をどの順で出すかは `web/src/usageChips.ts` の `usageChips()` / `chipsLevel()` に 1 つだけ置く（#347。`usageChips.test.ts`）。Claude が先。Claude は 5 時間の枠が無ければ週に落として `週` の印を付ける。上限中は割合が無くても出す。
- パネルの「ステータスラインを設定すると出ます」の案内は、割合が 1 つも無いときだけ出す。

## rev が同じなら 304（#592）

- `app.ts` の `jsonByRev()`。一覧・詳細・フィードの 3 つだけが通す。`ETag` は `rev` の sha1 の頭 20 桁で、`If-None-Match` が合えば本文を作らずに 304。
- rev を組むまでの仕事（行の集計・走査の結果）は減らない。減るのは JSON にする・送る・画面がパースする分。
- `X-SAI-Build` は 304 にも付く（`watchBuild` が見る）。

## ビルドへの追従

- サーバは `web/dist/` を毎回ディスクから読み、`/api/*` に `X-SAI-Build`（`dist/index.html` の mtime）を付ける。
- `web/src/api.ts` の `watchBuild` がポーリングのついでにそれを見て、変わっていたら `location.reload()` する。`pnpm dev` 中は HMR に任せて何もしない。
- サーバ側の再起動は `pnpm start:watch`。

## ビルドが古いことの判定（local/buildFreshness.ts）

- `server/local/buildFreshness.ts` が `web/dist/index.html` と `web/src` / `web/index.html` / `shared`（`*.test.ts` を除く）の mtime を 30 秒に 1 回比べる。
- 結果は `/api/sessions` と `/api/feed` の `build_stale` に載せ、`rev` にも混ぜる。
- `App.tsx` はそれでヘッダの下にバナーを出す（`pnpm dev` では出さない）。
- git は叩かない。

## フックの配線のずれ（local/claudeHooks.ts）

`SessionsResponse.hooks_missing` → `App.tsx` のバナー（#567）。

- あるべき一覧は `shared/hooks.ts` の `EXPECTED_CLAUDE_HOOKS`。README「1. フックを向ける」の JSON の例と `server/docs.test.ts` が突き合わせる。
- 判定は同じファイルの `claudeHookGaps()`（純粋関数）。「このコマンドは `record.py` に届くか」は関数で受ける。
- 届くかは `server/local/claudeHooks.ts` の `reachesRecord()`。`/setup-sai` の `reaches()` と同じ規則で、コマンドに `record.py` を含むか、先頭の語をサーバの `PATH` で引いたスクリプトの中身が呼ぶか。
- `ClaudeHooks` は `~/.claude/settings.json` を読むだけ。30 秒に 1 回 mtime を見て、変わったときだけ読み直す（3 秒のポーリングで読まない）。
- 行からは分からないので設定を見る。
- 分からないなら出さない: 届くフックが 1 つも見えない（ラッパーがサーバの PATH に無い・別の置き場で繋いでいる）ときは `null`。窓にこのマシンの Claude の行が無いときも出さない。
- 本物の設定を読むのは `main.ts` だけ（`TerminalDeps.claudeHooks`）。`createApp` の既定は `NoClaudeHooks`（読まない）。
- `/setup-sai` は同じ判定を `node server/hooksCheck.ts` で回す。
- 足りない値は rev にも混ぜる（直したら次の行を待たずに消える）。

## Claude のログイン切れ（local/claudeAuth.ts。#685）

- `ClaudeAuth.check()` が `claude auth status --json` を起こし、`parseAuthStatus()` が `loggedIn` と `authMethod` だけを読む（`email` / `orgName` などは持たない）。終了コードは見ず、stdout の JSON を読む。`claude` が無い・古い・時間切れ（`AUTH_TIMEOUT_MS` = 5 秒）・壊れた出力は `undefined`（分からない）で、前の結果も捨てる
- 走っている 1 本を待ち、`AUTH_CACHE_MS`（5 秒）の間は聞き直さない（返信がまとめて失敗しても 1 回）。`peek()` は前の結果を返すだけで `claude` を起こさない
- 聞くのは 3 か所だけ: `main.ts` の起動時、`app.ts` の `withAuth()`（Claude の返信が失敗したとき）、`POST /api/claude-auth/check`（画面の「確かめ直す」。同一オリジンのみ）
- `withAuth()` は `replyingOf()` の結果を受け、**プロセスが非 0 で終わった失敗**（`code` があり `turn_error` でない）のうち、Claude のものを見る。Claude かどうかは起こしたコマンド（`startedBin`。行の無い新しいセッションもこれで分かる）、無ければセッションの行で決め、どちらでも分からなければ聞かない（Codex・OpenCode の失敗に Claude のログイン切れと出さない）。`revWith()` は `logged_out` も混ぜる。失敗 1 つ（`<id>` と `since`）につき 1 回だけ `check()` を待ち、`loggedIn: false` なら `failed.logged_out: true` を付ける。**失敗が最初に見えた応答で待つ**のは、画面（`useReply`）が失敗を 1 回しか読まないため
- 一覧は `peek()` が `loggedIn: false` のときだけ `claude_logged_out: true` を載せ、`rev` に混ぜる。画面は `web/src/ClaudeAuthBanner.tsx`（文は `claudeAuthNote.ts`）
- 本物を渡すのは `main.ts` だけで、`createApp` の既定は `NoClaudeAuth`（聞かない）

## 返答に出てきたファイルを読む（local/files.ts。#603）

- `GET /api/sessions/<id>/files/<key>`。画像（`local/images.ts`）と同じ作りで、**パスはリクエストから受けない**。`fileTable()` がそのセッションのターン完了の行の本文から `shared/files.ts` の `fileRefs()`（`` `コード` `` のうち `fileRefOf()` がパスの形と見たもの。拡張子は `TEXT_EXT` の一覧）で拾い、`fileKey()`（`imageKey()` と同じ）の鍵で引く。自分の入力・待ちの行・`thinking` は見ない
- `readSessionFile()` の順: 書かれた名前が `isSecretPath()` に当たれば 403 → cwd と対象を `realpath` → cwd の外は 403 → **リンクを解いた先の相対パスでももう一度 `isSecretPath()`** → `O_NOFOLLOW` で開く → ファイルでなければ 404 → `FILE_MAX_BYTES`（1MB）超は 413 → `decodeText()`（NUL を含む・UTF-8 として読めないものは 415）。返すのは文字と名前だけ
- **出す相手は `app.ts` が決める**: `who.kind !== 'local'`（Serve のヘッダ付き）は 403、`Host` がループバックの名前でない（`isLoopbackHostHeader()`。DNS の付け替えへの備え）も 403、別のマシンのセッションは 404。応答は JSON（`SessionFileResponse`）で、ファイルそのものを `text/html` などで配る口は無い
- 画面: `Inlines` の `code` は `CodeSpan`。`FileSessionContext`（`Chat` がバブルごとに渡すセッション ID。自分の入力・別のマシン・一言の行・ビューアの中は null）と `FileOpenContext`（`FileViewerProvider`）があり、`fileRefOf()` が当たるときだけボタンにする。ビューアは `FileViewer`（開いたときに 1 回読む。別のファイルは `key` で作り直す）。元の文字は行番号と本文の 2 つの `<pre>`（行ごとに要素を作らない）で、行の高さは `FILE_LINE_H`（18px。CSS の `--file-line-h` と揃える）に固定し、飛び先の印とスクロール位置を行番号から決める。出し方・行の分け方は `web/src/fileView.ts`
- テスト: `shared/files.test.ts` / `server/local/files.test.ts` / `server/session-files.test.ts`（本物の `createApp`。tailnet 越し・名前で断るもの・パスそのものを渡したもの）/ `web/src/fileView.test.ts`

## 画像の軽い版（local/thumbnails.ts）

枠（バブルの下 96px・本文の中 最大 320px・添えた画像）に元の画像を読ませないための `?thumb=1`（#589）。

- 口は 4 つ（`/images/<key>`・`/transcript-images/<key>`・`/codex-images/<key>`・`/api/attachments/…`）。前の 3 つは `app.ts` の `sendImage()`、添付は同じ形をその場で書く。**どれも今の読み方で読み終えたバイト列**（realpath が置き場の中・中身で種類を判定・上限以下）を `ThumbMaker.thumb()` に渡すだけで、`?thumb=1` で読む条件は変わらない。
- `Thumbnails.thumb()` は、`THUMB_MIN_BYTES`（200KB）未満なら `original`（元のまま）。それ以上はバイト列を置き場（feed dir の `thumbs/`）に `<sha256 の頭 32 桁>.src` として書き、**そのパスだけ**を `sips` に渡す（`sipsShrink()`。形は決め打ち・`execFile`・15 秒の締切）。出来たものは `<ハッシュ>.jpg|png` に置き、次からはそれを読む（鍵が中身なので古くならない）。
- 形式は `hasAlpha()` で決める: JPEG と透過の無い PNG は長辺 512px の JPEG（品質 75）、透過のある PNG（IHDR の色の種類 4 / 6、IDAT より前の `tRNS`）・GIF・WebP は長辺 384px の PNG。縮めても元より重ければ `original`。**`sips -Z` は小さい画像を引き伸ばす**ので、`imageSize()`（PNG / GIF / WebP / JPEG の見出しから縦横を読むだけ）で長辺が目標以下なら、PNG にするものは `original`、JPEG にするものは大きさを変えずに作り直す。
- 同じ中身を同時に頼まれたら 1 回だけ縮め、同時に回す `sips` は 2 つまで。置き場は 1000 枚を超えたら古いもの（mtime）から捨てる（50 枚作るごとに見る）。
- `sips` が無い（`ENOENT`）・失敗・締切は `unavailable` で、`sendImage()` は `503` + `X-SAI-Thumb: unavailable` + `X-SAI-Image-Bytes` を返す。`sips` が無いと分かったら以後は呼ばない。縮められなかった中身は 10 分覚えて回し直さない（`THUMB_FAILED_TTL_MS`。画面の見分けの HEAD がすぐ返る）。
- 軽い版の `ETag` は元の `ETag` に `t-` を付けたもの。`download=1` のときは `thumb=1` を見ない。
- `createApp` の既定は `new Thumbnails(join(store.directory, 'thumbs'))`（テストの feed dir は一時ディレクトリ）。テストは `TerminalDeps.thumbs` に偽の縮める口を渡した `Thumbnails` か `noThumbs`（縮めない）を渡す。
