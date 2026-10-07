# Codex の端末とapp-serverの仕組み

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/codex.md](../history/codex.md)。

画面から見た振る舞い（ダイアログの出方・3 つの歯止め・止めるボタン）は [screen.md](../screen.md) の「端末（tmux）で開いているセッションには打ち込む」「処理中の間は、いま何をしているかが出る」、口の形は [api.md](../api.md) の `POST /api/sessions/<id>/interrupt` と `POST /api/approvals/<approval_id>/answer`。

## ダイアログの検出

- Codex の `notify` はターン完了時しか来ないため、`server/reply/codexDialogs.ts` が画面の 3 秒ポーリングに合わせて、端末付きの Codex セッションだけ `inspectPrompt()` で確認する
- ペインの pid と記録時の Codex pid の親子関係を毎回確かめ、ダイアログ中なら JSONL ではなく検出専用の `Approval`（`agent: codex`）として一覧・フィード・詳細に載せる
- ダイアログが消えた、ペインが消えた、pid が違う、のどれでも次のポーリングで消す
- `SAI_TERMINAL=0` なら監視もしない
- 渡す一覧はアーカイブ済みを除く前のもの

## ダイアログの中身を読む

- `shared/codexDialog.ts` の `parseCodexDialog()`（純粋関数）が、画面の文字を見出し・説明・`$` のコマンド・番号付きの選択肢にし、`PromptState.dialog` → `Approval.dialog` として画面に出す（`web/src/DialogPreview.tsx`）
- 一覧の 1 行は `codexDialogText()` が `Codex の許可待ち: git add -A` にする
- 塊の切り方: 会話の側は字下げが無いので、選択肢から上へ「2 文字下げの行」を辿る。ただし引用の枠（`  │ …` / `  └ …`）はダイアログと同じ字下げなので、そこで止める
- **深い字下げ（3 文字以上）の行も辿る**（#595）。折り返した選択肢の続き（番号のぶん深い 5 文字下げ）と、複数行のコマンドの中の字下げがこれに当たる。辿ったあと `headStart()` が、`$` のコマンド（無ければ最初の選択肢）より上にある深い字下げの行の下から読み直す（そこは会話の側のツールの出力。見出し・説明は 2 文字下げで折り返す）
- 読めなければ今までどおりの 1 行に落ちる
- 中身は `approval_id` にも混ぜる（`approvalMapKey()` は id しか見ないので、混ぜないと次の許可に変わったことを画面のポーリングが拾わない）。カーソルの位置は混ぜない（矢印で選び直しただけで待ち始めた時刻を戻さない）

## ダイアログに画面から答える

- `CodexDialogs.answer()`。押された選択肢まで印を矢印で動かして `Enter` を送る。近道キーは使わず、どのダイアログでも同じ手にする
- 読み直しは 3 回: ①送る前に同じダイアログか（`codexDialogKey()`。カーソルの位置は含まない）、②動かしたあとに印が狙った所に来たか、③`Enter` のあとに消えたか。どれかが食い違えば `409`
- 選択肢の組み立てと検査は `shared/codexDialog.ts` の `dialogDecisions()` / `dialogDecisionIndex()` / `dialogSteps()`（純粋関数）
- **「今後も聞かない」（2 番）は `dontAskScope()` が範囲を全部読めたときだけボタンにする**（#741）。読めたとするのは: その選択肢が 1 つだけ・文が `` ` (p) `` で終わっている（折り返しの終わりまで辿れて引用符が閉じている）・`…` が入っていない・範囲が見出しのコマンドの 1 行目の頭と語の区切りで一致する（コマンドが折り返している・複数行のときは、1 行目の途中の区切りまでに収まるときだけ）・`DONT_ASK_SCOPE_MAX`（120 字）以内。ボタンの文言は `dontAskLabel()`（範囲そのもの）で、id は今までどおり `opt-<番号>`。読めなければ落とす（ボタンは「はい」「いいえ」の 2 つ）。範囲の文は選択肢のラベルとして `codexDialogKey()` に入っているので、読み直して範囲が変わっていれば別の `approval_id` になり、`answer()` は `409` でキーを送らない
- 中身が読めていないダイアログは `answerable: false` のまま
- **半分しか読めなかったものも `answerable: false`**（#595。`dialogAnswerable()`）: 番号が 1 から続いていない・印（`›`）がちょうど 1 つでない・選択肢が 1 つだけ・「はい」に当たるものが残らない。`decisions` を付けず（ボタンが出ない）、`answer()` も最初に同じ判定で `409` を返す。`dialog`（読めたぶん）は載せたまま
- 答える口は既存の `POST /api/approvals/<id>/answer` に相乗り

## 行の pid が死んでいるときの補欠

- `server/reply/codexTerminal.ts` の `CodexTerminals`。pid が死んでいる Codex は、thread writer lock（`codexWriterLockPath()`）を握っている生きたプロセスを本体として引き直す
- lock はセッション ID ごとのファイルなので、同じペインで別の Codex を起動し直していても取り違えない。ペインとの対応は `inspectPrompt()` の `isDescendant()` がそのまま確かめる
- 結果は `CODEX_PID_TTL_MS`（30 秒）覚える。見つからなかったことも覚える
- `lsof` が使えないときは 0（端末扱いにしない）。`codexWriterActive()` は同じ材料で「開いている扱い」に倒すが、あちらは閉じたセッションに queue を渡さないための判定、こちらは打ち込む先を決める判定なので、倒す向きが逆になる

## 行の pid が生きていてもペインの中かを見る

- `CodexTerminals.owner()`。行の `pid` がペインの子孫のときだけ採り、外なら上の補欠に落とす（30 秒覚える。一覧は締切で前回の結果、初回は今までどおり行の pid）
- **ペインの子孫でも `codex app-server` は端末にしない**（#653）。`server/app.ts` の `inPane` が子孫かを見たあと `codexAppServer(pid)`（`ps -p <pid> -o command=` を `isAppServerCommand()` で読む。`server/reply/codexPanes.ts`）を当てるので、行の pid を見る `owner()` と lock の持ち主を見る `pid()` の両方に効く。`CodexPanes.scan()` も同じ判定でデーモンを飛ばす（デーモンは回している全スレッドの rollout を開いているので、数えると一番新しい名前の rollout がそのペインの会話に化ける）。見るのはサブコマンドの位置の `app-server` だけ（最初の入力に出てくるだけの TUI は巻き込まない）。`ps` が読めなければ app-server 扱い（端末にしない。分からなければ当てない）
- 共有の `codex app-server --listen unix://` の客の TUI では、行の `pid` は tmux の外の app-server、`pane` は app-server を起こしたペインになり、その app-server が回すどのスレッドの行も同じペインを指すため
- Claude は触らない

## 客の TUI を起動時の会話に結ぶ

- `codexPanes.ts` の `rolloutSessionAtStart()`。ペインの側からの引き当ての補欠
- 次の材料が全部合うときだけ当てる（1 つでも合わなければ当てない）:
  1. 起動秒〜 `START_SLACK_S`（2 秒）後の名前・同じ cwd・TUI が作った目印（`~/.codex/tui-thread-reference-capabilities/<id>`。起動と `/new` のときだけできる）の rollout がちょうど 1 つ
  2. その rollout を開いている app-server の客である（`lsof -U` の番地。`isClientOf()`）
  3. その app-server が同じ cwd の別のスレッドを読み込んでいない（`/new`・`/resume` したスレッドは読み込まれたまま残る）
  4. ペインのスクロールバックに `codex resume <その id>`（離れたときに出る）が無い
- `/resume` で映している会話は取りこぼす（起動時刻が合わない。上流に口が要る）

## ペインの側から探す

- `server/reply/codexPanes.ts` の `CodexPanes`。`tmux list-panes` と `ps` のコマンド名でペインの子孫の `codex` を見つけ、その codex がいま開いている rollout からセッション ID を引く（`lsof -a -p <pid> -Ffn` の 1 回で cwd と一緒に取る。`parsePaneFiles()` / `rolloutSession()`）
- 置き場の前方一致は realpath にも揃える（#434。`sessionRoots()` が「書いたとおりの形」と realpath の両方を返す）。`lsof` はリンクを解いた実パスを返すため。返すパスは lsof が返したまま（そのまま開くので）。`record.py` の `resolve_codex_session()` が比較のときだけ realpath に揃えるのと同じ
- cwd からは引かない（#429）。引けなければ空にして当てない（別プロセス / queue の経路は残る）
- 拾えるもの 2 つ:
  - 記録はあるが lock で引けないセッション（`terminalOf()` の 2 段目の補欠）。行の `pane` ではなくいまのペインを使うので、ペインを移していても当たる
  - 行が 1 本も無いセッション（`notify` はターン完了でしか鳴らないので、最初のターンの許可で止まると記録に 1 行も無い）。ダイアログの監視にだけ足し、一覧と集計は触らない（`paneOnlyTargets()`。id は `entityId(session, <cwd の git のトップの名前>, '')`。行のあるセッションは足さない）
- 走査は `CODEX_PANES_TTL_MS`（30 秒）覚える。tmux が落ちたときは前の結果を捨てない。失敗も同じだけ覚える（#435）
- `SAI_TERMINAL=0` では `scan()` を呼ばない（`terminalOf()` の早期 return と、`approvalsNow()` の三項の中に `paneOnlyTargets()` を置いてあるため。`server/terminal-off.test.ts` が留める）
- rollout の頭は 64KB 読む（1 行目の `session_meta` が大きい）

## 走査の締切

- 走査は要求の中で `SCAN_WAIT_MS`（0.7 秒。`server/reply/softWait.ts` の `softWait()`）までしか待たない。間に合わなければ各走査の前回の結果（`last()` / `snapshot()`）で返し、走査は裏で続く（同時に 1 本）
- **1 度でも走査が終わっていれば、画面の道はまったく待たない**（#592。`screenWait()`。各走査の `known()` で見る）。前回の結果をすぐ返し、走査は裏で続いて次のポーリングが拾う。0.7 秒を待つのはサーバを立てた直後の 1 回だけ
- `CodexDialogs` / `WaitingSettle` の走査は `DIALOG_SCAN_TTL_MS`（5 秒）覚える（#592）。覚えている間は `tmux` も `ps` も起こさない。**前の走査が見ていない相手が居れば、覚えている間でも見に行く**（窓の広い口が狭い口の結果で取りこぼさない）。`ps` は 1 回の走査で 1 本だけ（`sharedPs()`。対象ごとに起こさない）。`answer()` は覚えた結果を使わず毎回読み直す
- `tmux` も 1 回の走査で 2 本だけ（`sharedTmux()`）: ペインの pid は `list-panes -a` の 1 本、画面は `capture-pane ; display-message <区切り> ; …` の 1 本。区切りは走査ごとの乱数で、並べるのは一覧に居るペインだけ。**まとめて取れなければ 1 つずつ聞く道に落ちる**（`list-panes` が読めない・途中でペインが消えた・区切りの数が合わない）。`answer()` と `typeInto()` は通さない
- 覚えるのは**相手ごと**（`seenAt`）。走査は今回見なかった相手の前の結果を消さず、TTL の `SCAN_KEEP_FACTOR` 倍（30 秒）を過ぎたものだけ落とす（絞り込んだ口の走査が、一覧の結果を消さない）
- 締切を当てるのは画面に出す道だけ（`terminalOf(s, { soft: true })` は一覧だけ）。返信の振り分けとレビューの断りは待ち切る
- `terminal` が付いた・消えたは `terminalKey()` で rev に混ぜる

## SAI から始めた Codex の質問・許可

- `CodexAppServer` は初回に stdio の app-server を起動して接続を保持し、`experimentalApi` と `approvalsReviewer: user` で管理する
- server request の `(request id, threadId, turnId, itemId)` を同じ接続に束ね、`request_user_input`、コマンド、ファイル変更、追加権限を `Approval` にする
- コマンドの `availableDecisions` は実値をサーバ内に隠して不透明な id だけ画面へ渡し、ファイルと権限もプロトコルが許す候補だけを作る
- 別 thread / turn、未提示の decision、二重回答は拒否。`serverRequest/resolved`、turn 完了、idle、切断で消す
- **SAI 自身の「常に許可」（Claude の設定に書くルール。`AlwaysRules`）は Codex には出さない。Codex が候補に出してきた規則の追加は、範囲を書いてボタンにする**（#741）
  - 対象は `availableDecisions` の `acceptWithExecpolicyAmendment`（語の並びで始まるコマンドを今後聞かない）と `applyNetworkPolicyAmendment`（ホストへの通信を今後聞かない／今後も断る）。押すと Codex が自分の規則（`CODEX_HOME/rules/default.rules`。セッションをまたいで残る）に足す。**SAI はそのファイルを読まないし書かない**
  - 文言は `server/reply/codexAmendment.ts` の `amendmentLabel()`: 「`git status`」で始まるコマンドを今後聞かない／「`example.com`」への通信を今後聞かない（`action: deny` は「今後も断る」で、ボタンの向きも拒否）。範囲は**候補そのものの中身**から読む（押したときに Codex へ返す値。別の欄の `proposedExecpolicyAmendment` は詳細に出すだけ）
  - **範囲をボタンに書き切れないときは、その候補を出さない**（切って見せない）: 配列でない・空・文字でない語・空の語・制御文字や改行・`AMENDMENT_WORDS_MAX`（12 語）超・`AMENDMENT_RANGE_MAX`（80 字）超、ホストが名前として読めない・`action` が allow / deny 以外。落とした候補の id は画面に渡らないので、答えにも使えない（「出していない decision」として断る）
  - 空白や引用符を含む語は `"…"` で囲む（`/bin/zsh -lc "touch out.txt"`。語の切れ目が分かるように）
- コマンドに「拒否」が無いことがある（実測 0.160.1 では `accept` / `acceptWithExecpolicyAmendment` / `cancel` だけで、`decline` が来ない）。SAI は来ていない decision を足さないので、そのときは「ターンを中止」しか選べない

## ターンを止める

- `POST /api/sessions/<id>/interrupt` → `interrupt()` がどちらが回っているかで振り分ける
- Codex: `CodexApp.interrupt()` → `turn/interrupt`。止められるのは SAI が `thread/resume` したスレッドだけ。`turn/start` の応答前（`turnId` がまだ無い）は止めないので、画面のボタンも出さない（`Replying.interruptible`）
  - 投げる前に預かりを止める（`queue.pause()`）。`turn/interrupt` のあとの `turn/completed` が `onTurnEnd` → `drain()` に繋がっているため。人が「続けて送る」を押したときだけ回す
  - 応答が返ったらこちらでも `clearThread()` する（イベントが来ないまま黙ったときに「処理中」が残らないように。2 回目は何もしない）
  - そのターンが起こしたシェルのコマンドは SAI は殺さない（別のスレッドのコマンドまで巻き込むため）
- OpenCode: `OpencodeServer.abort()` → `POST /session/<id>/abort`
  - `abort` の返り値は当てにしない（回っていない・知らないセッションにも `true` が返る）。止めてよいかは SAI が回しているか（`running()`）で決め、回していなければ投げない
  - 止めたら行を待たずに処理中から外す（Codex の `clearThread()` と同じ）
  - SAI が起こした serve がもう居なければ、処理中から外して止まった扱いにする
  - `prompt_async` が 204 を返した時点で回っているので、`Replying.interruptible` は最初から付く（`turnId` を待たない）
  - 止められるのは SAI が起こしたサーバのターンだけ（#421 と同じ線引き）
- Claude の `-p` は入力の口（stream-json）が開いていれば同じ口で止める（#386。[reply.md](reply.md) の「Claude の `-p` を止める・足す」）。口の無い `-p`（立て直しで引き取った子）は `400`
