# web（画面）の仕組み

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/web.md](../history/web.md)。

画面の見え方（利用者から見た動き）は [screen.md](../screen.md)、API は [api.md](../api.md)。ここにはそれ以外の、コードの側の話を置く。

## 画面の構成とルーティング

- `web/src/` は React 19 + Vite。1 画面で、左サイドバー（`SessionList`）に一覧、右ペインにチャット（`FeedView` / `SessionView`）。
- ルーティングは hash（`#/` と `#/feed` がフィード、`#/todo` が要対応、`#/s/<id>` がセッション）。広い画面では `#/` と `#/feed` は同じ表示で、狭い画面だけ `#/` が一覧のみになる。切り替えは CSS の `main.route-*`。
- route の `ts` / `side`（検索・発言のリンクの飛び先）は `parseRoute` / `sessionHash`（`hooks.test.ts`）。

### セッションを横に並べる（#633）

- 並びの形と動かし方は `web/src/paneLayout.ts` の純粋関数（`paneLayout.test.ts`）。`PaneLayout` は **列の配列で、各列が上から下への配列**（いまはどの列も 1 つ。上下を足すための形）と `focus`（フォーカスのある列）、`keys`（列ごとの番号）。要素は種類つき（`session` / `todo`）で、上限は `MAX_COLUMNS` の 1 つ。
- 持つのは `App.tsx`（`useLocalState('sai.panes')`。読んだものは毎回 `normalizeLayout()` を通す）。**URL はフォーカスのあるペインの 1 つを指し、`parseRoute()` は変えていない。**
- URL → 並びは `placeItem()`。**route が変わったときだけ**描画中に合わせる（`placed` に前の route を覚える。effect の中で setState しない）。並び → URL は、操作（`openBeside()` / `focusColumn()` / `closeColumn()`）のあとに `location.hash` を書く。
- 「いま開いているセッション」は `currentId`（route がセッションのとき、並びのフォーカスの ID）。題名・差分・`SessionView` の `focused` はこれを見る。**`route.id` を直接見るのは `focusTs` / `focusSide`（発言への飛び先）だけ。**
- 描くのは `.panes` の中の `ChatPane`（`.pane`）で、並べているときだけ `.panes.split`。`ChatPane` の key は並びが持つ列の番号（`PaneLayout.keys`。列の位置ではない）: 中身を入れ替えても番号は変わらず（1 つのときは今までどおり同じ `SessionView` が `id` だけ変わる）、左を閉じた・間に足したときも残った列の番号は動かない。× は見出しでなく `ChatPane` に置く（読み込み中・取得に失敗したペインも閉じられる）。
- `→` の当て先は `.pane.focused .reply textarea`。ヘッダの取得状況（`onStatus`）はフォーカスのあるペインにだけ本物を渡す。
- キーボードは `paneKeys.ts` の `paneKey(e, typing)`（`paneKeys.test.ts`）を `App.tsx` の window の keydown が呼ぶ。`%` で入れるセッションは `nextUnshown()`（サイドバーの `visibleIds()` の並びで、いまの次の、まだ出していないもの）。`Ctrl+数字` は `focusPane()` のあと `focusLater` に入力欄を頼む（当て先の `.pane.focused` は描き直したあとに変わるので、その場では当てない）。
- 要対応のペインは `ChatPane` の `onClickCapture` で `a[href^="#/s/"]` のクリックを先に見て、`openInNeighbor()`（押されたペインの列を起点に）で隣へ開く。`TodoRow` には何も渡していない。
- ⌘K の `⌘Enter` は `CommandPalette` の `onOpenBeside(hash)`。許可のバブルの `⌘Enter`（window の capture）が先に拾わないよう、`hotkeyApplies()` の第 3 引数（`role="dialog"` の中で押されたか）で断る。
- 差分は `visibleDiff()` の第 4 引数に並んでいる ID を渡す（並びのどれかなら出したまま）。モーダルにするかは `useNarrow()`（900px 以下）だけで決め、並べている数は見ない（#647）。

## データ取得（usePolling）

- `hooks.ts` の `usePolling` がデータ取得の中心で、`rev` が変わらない限り state を触らず、タブが隠れている間は止まる。
- `hiddenMs` を渡された時だけ裏でも回る（`HIDDEN_POLL_MS` = 20 秒）。渡すのは `App` の一覧だけで、チャットとフィードは今までどおり止まる（通知のため。下の「タブの題名と通知」）。
- `rev` が同じでも `updatedAt` のために 3 秒ごとに state を更新する（最下部追従が高さで見る理由。下の「最下部追従」）。
- **一覧・詳細・フィードは、変わっていなければ本文を受け取らない**（#592。`revCache.ts` の `fetchByRev()`）。前の本文を URL ごとに 8 個まで覚え、`If-None-Match` を付けて聞く。304 なら覚えた本文（同じオブジェクト）を返すので、`usePolling` から見ると今までどおり「rev が同じ」。ブラウザのキャッシュには任せない（`no-store` のまま）。
- フィルタは `useLocalState` で localStorage に残る。絞り込みの state は `App.tsx` が持ち、サイドバーとフィードの両方に渡す。

## 要対応（TodoView。#224）

### 組み立て

- いま自分を待っているものだけを待たせている順に出す画面で、サイドバーの固定項目「フィード」の下に件数のバッジ付きで並ぶ。
- 組み立ては `shared/todoItems.ts` の `todoItems()`（`todoItems.test.ts`）。`web/src/` ではなく `shared/` に置く（#340。サーバからも同じ判定を呼べるようにするため）。`Notification` を触る `web/src/useNotify.ts` だけが画面側に残る。
- `approvals`（サーバの `Approvals.snapshot()` そのもので絞り込みを通っていないので、一覧から消えていても出す＝ここで答えられる）と `SessionSummary.waiting`（行から見た待ち。絞り込みに従う）の 2 種類に分ける。
- 「終わって次を待っているだけ」は別の区分 `done`（#438）。判定は `todoItems.ts` の `awaitsNext()`＝`SessionSummary.idle` か、最後の行がターン完了（集計の `SessionSummary.last_kind === 'turn'`。#513）。**時刻 `end === last_turn_ts` では比べない**（行の `ts` は秒までなので、同じ秒に届いた次の入力や `/clear` を見分けられない）。返信が処理中なら経路を問わず外す。文言は一言か最後の発言。
- 画面は上段（`answer` / `watch`）と下段（`done`）に分ける（`web/src/TodoRow.tsx` が両方の 1 行を描く）。未読の返答があるもの（`SessionSummary.unread`）は答え待ちの次の「未読」の段に上げる（#551。`todoSections()`。答え待ち → 未読 → 待機中 → 終了、段の中は待たせている順。並べ替えるだけで区分と数えるぶんは変えない）。
- `done` はバッジ・タブの題名・通知には数えない。数えるぶんの判定は `shared/todoItems.ts` の `pendingItems()` 1 つに置く。
- `chatGroups.ts` は `idle` の行をバブルにしない（ターンが終わったことは直前の返答のバブルで分かる）。
- `replying[].failed` は出さない（2 分で消えるので取りこぼす）。
- `watch` の文言は `replyBlockedReason()` で判定した `TodoItem.replyable` で分ける（#232。「SAI からは答えられない」とは書かない）。
- 別プロセスの返信を処理中（`replying[id]` があり `via !== 'terminal'`、`failed` 無し）のセッションは `watch` を出さない。`-p` の許可・質問は必ず `--permission-prompt-tool` を通るので、待っていれば `answer` に載っている。行の `waiting` は待ちの行のあとターン完了が届くまで消えず（許可・質問への回答は `UserPromptSubmit` ではないので `record.py` は再開の行を書かない）、答えたあとも残ってしまうため。端末に打ち込んだ返信は行の `waiting` しか手がかりが無いので残す。
- 組み立ては 3 か所（要対応の画面・サイドバーのバッジ・題名と通知）が同じ引数で呼ぶ（渡し忘れると件数だけ食い違う）。
- この画面はデータを取りに行かない（`App` の一覧の結果をそのまま使うので API もポーリングも増えない）。

### 端末で答えた待ちを畳む（WaitingSettle。#255）

- 端末で人が答えたぶんは、次のターンを待たずにサーバ側で畳む（`server/reply/waitingSettle.ts` の `WaitingSettle`）。`codexDialogs.ts` の裏返しで、あちらは「ダイアログが出ていたら待ちとして出す」、こちらは「ダイアログが消えていたら行の待ちを畳む」。
- 見るのは `terminal` があって `waiting` が空でないセッションだけ（普段 0〜1 件）。`inspectPrompt()` が `idle` / `typed` を返したときだけ畳み、`unknown` と例外（ペインが無い・pid が別物）は残す（材料が無いのに待ちを消さない）。#234 以前の古い行が SAI サーバのペインを指していても、そこには `❯` が無いので `unknown` に落ちて安全。
- 畳むのは `createApp` が応答を組み立てるときだけで集計（行）は触らないので、要対応・サイドバー・チャット見出しが同時に正しくなる。畳んだ集合は `settledKey()` で rev に混ぜる。`SAI_TERMINAL=0` なら見に行かない。

### 行から次の指示を送る（#522）

- `web/src/TodoReplyBox.tsx`。中身はセッション画面の `ReplyBox` そのもので、打ちかけの鍵も同じエンティティ ID。
- 出す行の判定と開け閉めは `web/src/todoReply.ts` の `rowReplyable()` / `rowOpen()` / `pruneToggled()`（`todoReply.test.ts`）。`done` の行は最初から開き、`watch` は押したときだけ。
- 持つのは「人が既定から切り替えた行」の鍵（`toggleKey()` = 区分と id）で、並びから消えた行の分は描画中に忘れる。
- 確認から送り直した回数（`sentFromConfirm`）は行ごとに数える（いくつも開いているので、まとめて数えると開いているほかの行の打ちかけまで消える）。
- `useReply` は行ではなく `TodoView` が持つ（送ると行は「処理中」として並びから消えるので、行の中に持つと失敗を受け取る前に消える）。
- 閉じていた行に「入力欄に戻す」を当てるときは、打ちかけ（`sai.drafts`）に書いてから開く（`ReplyBox` は作ったときの `restore` を当てた扱いにするので、開くのと同時に頼んでも入らない）。
- 狭い画面では開かずセッション画面へのリンク。

### もとの本文を開く（#537）

- 一言（要約）が出ている「終了」の行は、もとの本文を行の下に開ける（`web/src/TodoSource.tsx`）。出す行は `web/src/todoRowSource.ts` の `sourceTs()` で、行の文言が一言のときだけ。
- 一覧の `last_text` は 1 行目の 120 字しか無いので、押したときに 1 回だけ `GET /api/sessions/<id>/turn?ts=<last_turn_ts>` でそのターン完了の行を取る。一言は `(id, last_turn_ts)` で引いているので、同じ `ts` なら新しいターンが届いても取り違えない。ポーリングには載せない。
- 折りたたみの判定は `Message` と同じ `web/src/longText.ts` の `isLong()`。

### タブの題名と通知（#231）

- 同じ `todoItems()` から、タブの題名の件数（`(2) SAI`）と通知も作る（`shared/notify.ts` の `titleWith` / `notifyKey` / `appeared` / `notifyPlan` を `web/src/useNotify.ts` が使う。`notify.test.ts`）。判定を増やすとバッジと通知が食い違うので、待ちの定義は `todoItems()` の 1 つだけにする。
- 通知は入にした時だけ（`UserMenu` の項目、localStorage の `sai.notify`）、タブが隠れている間だけ、新しく待ちに入ったものだけ鳴らす（鍵に `since` を混ぜるので鳴り続けない。最初の 1 回は覚えるだけ）。
- そのため `usePolling` は `hiddenMs` を渡された時だけ裏でも回る（上の「データ取得」）。

## リポジトリの絞り込み

- リポジトリは `SessionList` と `FeedView`（見出しの `#sai` がそのままボタン。#215）の 2 か所の `ProjectPicker` から変えられるが、触るのは同じ `filters.projects` の 1 つ。狭い画面では一覧とフィードが別画面なので、フィード側に口が無いとサイドバーまで戻ることになる。
- 複数選べる（#529。空ならすべて、どれか 1 つに当たれば出す）。判定と表示は `shared/projectFilter.ts`。クエリは `?project=a&project=b`。localStorage の古い `project`（1 つの文字列）は `storedProjects()` が引き継ぐ。
- 候補は `App` が持っている一覧の `filters.projects` を渡すだけで取得は増やさない。いま選んでいるものは候補に無くても必ず並べる（`web/src/projectChoices.ts`）。

## コンポーネントの置き方

- `.tsx` は 1 ファイル = 1 コンポーネント、ファイル名 = コンポーネント名（oxlint の `react/no-multi-comp` が `pnpm lint` で止める）。小さい部品（`More`、`SynthTag`、`MenuMark` など）も自分のファイルに置く。
- コンポーネントでないロジックは `.ts` に出す（例: `chatGroups.ts` の `groupRows()` はチャットの行をバブルの塊にまとめる純粋関数で、`chatGroups.test.ts` を node:test で回す）。
- 静的に並べた兄弟に同じ `key` を付けない（#264。`web/src/siblingKeys.test.ts` が `.tsx` をソースで見て止める）。`key` は「別のセッションに移ったら作り直す」ために付けることがある（見出しの操作 `SessionHeadActions` の `MetaEditor` などが編集中の状態を持ち越さないため）が、同じ親の中で重なると React の再調整が古いぶんを見つけられず、更新のたびに増え続ける。位置で対応が付いているうちは表に出ず、並びが崩れたときに初めて出る。本番ビルドは React の重複 `key` の警告が落ちているのでコンソールにも何も出ない。`archive:` / `meta:` のような接頭辞を付けて 1 つずつ別の `key` にする。`.map()` の中は 1 回しか書かれないので対象外。
- effect の中で setState しない（oxlint の `react/set-state-in-effect` が止める）。状態は描画中に導く（`focusLater`、`useSearch`、`clearsOnSent()` が同じ考え方）。

## チャット見出し（#274）

- 幅で 2 つの形を出し分ける（`SessionView` が `useNarrow()` で選ぶ）。広い画面は全部を並べ、狭い画面は `.chat-head.compact`（1 行目 = `BackLink compact` + 名前 + 状態の印 + `SessionHeadMenu` の `⋯`、2 行目 = `SessionTitle` の題名 1 行）。
- 中身は 2 つの形で共用する（`SessionHeadInfo` = 詳しい情報、`SessionHeadActions` = 操作、`SessionStatusTags` = 状態の印）。
- どの印を出すかは `web/src/headTags.ts` の `headTags()`（`headTags.test.ts`）の 1 つだけ。狭い画面の 1 行目で落とすのは素の出どころ（`payload` / `rollout`）だけ（合成と許可モードは残す。素通しを選んだまま忘れないため。#253）。
- 終わったターンの「手順」（#605）は `TurnSteps`（`Chat` が返答のバブルにだけ `steps={{ id, ts }}` を渡す。Claude / Codex のターン完了の行で、別のセッションの返答 #588 には付けない）。開いたときに `api.turnSteps()` を 1 回だけ呼び、閉じて開き直しても取り直さない。
- 「記録から補った」（#614）は行の `recovered` をそのまま出す（`Chat` → `Message` の `RecoveredTag`。自分側・待ちの行には出さない）。
- 「完了の記録なし」（#614）は、サーバが載せる `SessionSummary.stop_missing` をそのまま出す（`headTags()` の `stop_missing` と `SessionItem`。判定は画面でしない。→ [progress.md](progress.md#ターン完了の行が落ちた印614)）。返信中の印とは同時に出さない。
- 「アーカイブ後も継続」（#583）は `shared/archiveReturn.ts` の `returnedFromArchive()`（`meta.archived_at` があるのに `archived` でない）で決め、`headTags()` の `returned`・サイドバー（`SessionItem`）・要対応（`TodoRow`）が同じ関数を呼ぶ。入力欄の上の 1 行は `ArchiveReturnNote`（［このまま使う］= `api.setMeta(id, { archived_at: '' })`）。リンク先は `newerSibling()`（同じ `project` / `repo` / `host` で、アーカイブのあとに始まった一番新しいもの。候補は `App` が渡すサイドバーの一覧 `peers` なので、絞り込みで外れていれば出ない）。
- `⋯` のパネルは `.chat-head` の中に置く（タッチ端末の 16px / 36px の指定が `.chat-head` に閉じていて、外に出すと iOS で入力欄を押したときに画面が拡大する。#122 / #127）。
- 閉じ方は `web/src/useDismiss.ts`（`UserMenu` と共用）。外側を押したら中でフォーカスしている欄を先に blur してから閉じる（欄を離れたときに保存する Linear の workspace が消えないように）。Esc は capture で止める（App の Esc =「フィードへ」まで動かないように。`FeedProjectPicker` と同じ）。
- 一言の全体の設定（`DigestControls`）も、狭い画面ではヘッダの 2 行目ではなく `UserMenu` の中に入る。

## キーボード

- セッション移動は `sessionNav.ts` の純粋関数（`navAction` / `navTarget`）を `App.tsx` の keydown が呼ぶ（`sessionNav.test.ts`）。`navTarget()` は `NavTarget`（`feed` / `todo` / `session`）を起点にも行き先にも取り、固定項目 `PINNED` をセッションより上に並べた仮想の一覧で隣を返す。
- 入力欄との行き来（`→` で入力欄、空の入力欄で `←` で一覧。#204）は判定が 2 か所に分かれる: `→` は `navAction()` の `'input'`（window 側）、`←` は本文の中身を知っている入力欄しか判断できないので `web/src/replyFocus.ts` の `leavesToSidebar()` を `ReplyBox` の `onKeyDown` が呼ぶ（window 側は `isTypingTarget()` で入力欄のキーを捨てるため）。
- フォーカスの当て先は `App.tsx` が `focusLater` の ref で持ち、その場で当たらなければ描画のあとにもう一度探して `FOCUS_WAIT_MS` で諦める（effect の中で setState しない）。サイドバーの当て先はフィードが `<a class="item feed">` そのもの、セッションは `<div class="item">` の中の `<a class="link">` の 2 種類ある。

## サイドバーの塊（#364）

- 一覧はリポジトリごとの塊にして畳める（`web/src/sessionGroups.ts` の `sessionGroups()` / `visibleIds()` / `toggleCollapsed()`、`sessionGroups.test.ts`）。
- 塊は `project` ごとで、順は「中で一番新しいセッション」（`aggregate.ts` が新しい順に並べたものを最初に出てきた順でまとめるだけ）、`project` が空なら「その他」。塊が 1 つでも見出しを出す。
- 既定は全部開いた状態で、`App.tsx` の `sai.groups`（`GroupState.collapsed`）に畳んだものだけ覚える（新しいリポジトリが増えても勝手に畳まれない）。
- 画面の並びとキーボードの `↑↓` の並びは同じ `visibleIds()` から作る（別々に組み立てると、畳んで見えていないセッションに `↑↓` で移る）ので、`App` が `sessionGroups()` の結果を `SessionList` に渡す（`SessionList` 側で組み立て直さない）。
- 見出しには件数と中の「要対応」の数も出す（畳んで見落とさないため）。数は `todoItems()` の結果の id から数えるので、バッジと食い違わない。

## 入力欄（ReplyBox）

### 続きと案のゴースト

- 打ちかけの続き（#219）は `web/src/replySuggest.ts` の `suggestFrom()`（履歴の前方一致）と `acceptsSuggestion()`（カーソルが末尾のときの `→`）を `ReplyBox` が呼ぶ。
- タッチ端末では `→` を押せない（ソフトキーボードに矢印キーが無い）ので、`useMediaQuery('(hover: none) and (pointer: coarse)')` のときだけ入力欄のすぐ上に `SuggestionChip` を出し、押したら同じ受け取りの処理を呼ぶ（#349）。ボタンに出す文字は `suggestionLabel()` が 1 行にして切る。押しても入力欄のフォーカスは奪わない。
- 次に送る文面の案（#371）も同じゴースト・同じ `→`・同じチップに乗る（#373。`suggestionFor()` が出どころを決める）。
- Manager が置いた案（#565。`SessionSummary.manager_draft`）は、打ちかけが無いとき次に送る文面の案より先に出る。ゴーストと `→` は同じで、チップの代わりに `ManagerDraftCard`（出どころ・全文・長ければ畳む・入れる・捨てる。畳むかは `managerDraftFold.ts`）を入力欄の上に出す。入れた・捨てたら `api.suggestionAction()` でサーバから取り除き、届くまでは `ReplyBox` の中で伏せる。フィードには渡さない。
- ゴーストは textarea（`background: transparent`）の背面に `.field > .ghost` を敷いて描くので、字送りに関わる CSS（`font` / `padding` / `white-space` / 折り返し、狭い画面の `font-size` の上書き）は必ず両方に当てる（ずれると 2 行目以降で本文と重なる）。

### 長い貼り付けをファイルにする（#609）

- 判定と文言は `shared/pasteFile.ts`（`pasteBecomesFile()`: 設定が入で、コードポイントで `PASTE_FILE_MIN_CHARS` = 10,000 字を**超えた**とき。`pasteLabel()` / `restorePaste()` / `pastePreview()`）。
- 設定は `settings.json` の `paste_to_file`（既定は切）。`App` が `PasteToFileContext`（`web/src/pasteSetting.ts`）で渡し、`ReplyBox` が読む（入力欄はセッション画面・フィード・要対応の 3 か所から使うので、prop で配らない）。入切は自分のメニューの `PasteControls`。
- `ReplyBox` の `onPaste`: ファイルが貼られていれば今までどおり預ける。そうでなく文字が長ければ、`attach.canPaste()`（預け先がある・数に空き・10MB 以内。**同期で決める**）を見てから `preventDefault()` し、`useAttachments` の `addPasted()` が #608 の口（`POST /api/sessions/<id>/attachments?name=貼り付けた文.txt`）へ預ける。預けられなければ本文に入れる（貼った文を失わない）。既定の貼り付けを止めるので、選んでいた範囲は自分で消す。預けている間に入力欄が作り直されたら（別のセッションへ移った）、結果を下書きに足す。
- 添付の項目（`Attached.pasted`）に字数と貼った文そのものを持つ（置き場のファイルは画面から読めない）。`AttachmentStrip` が印を押せるボタンにし、押すと中身の頭と「本文に戻す」（`ReplyBox` の `restorePasted()`: 添付から外して本文の後ろに足す）を出す。
- 打ちかけ（`replyDrafts.ts`）は `pasted` も残す（文は `DRAFT_PASTE_MAX_CHARS` = 20 万字まで。超えたら添付だけ残り「本文に戻す」は出ない。**書くとき**に `withDraft()` が落とす）。
- `.thumb` の中の `button` は ✕ の指定（右上の小さい丸）を受けるので、印のボタンには打ち消しの CSS を当てている。

### 打ちかけ（#306）

- 入力欄の打ちかけ（本文と画像）はセッションごとに localStorage の `sai.drafts` に残す。
- 規則（空なら消す・7 日より古いもの／50 件を超えたものを捨てる・壊れていたら空）は `web/src/replyDrafts.ts` の純粋関数（`parseDrafts` / `draftOf` / `withDraft`。`replyDrafts.test.ts`）で、localStorage に触るのは `loadDraft` / `saveDraft` だけ。
- `ReplyBox` は `draftKey` を渡されたときだけ、作ったときに 1 回だけ読み、本文か画像が変わるたびに書く（送ったら空を書く = 消える。`↑` の履歴の中にいる間は `hist.current.draft` を書く）。
- 1 回しか読まないので、`SessionView` は `ReplyBox` に `key={`reply:${id}`}` を付けてセッションごとに作り直す。今も `usePolling` が id の変化で `data` を空にして一度外れるが、それは副作用で、id が変わった直後の 1 回の描画では A の `data` のまま id だけ B になる。作り直さないと A の打ちかけを B に送れてしまう。
- フィードには渡さない（返信先が `@` で動き、本文だけ戻しても合わない）。

### 返答の一部を引用して入れる（#604）

- 返答のバブルの中で文字を選ぶと、選択のすぐ下に `QuoteButton`（「引用して返信」）が出る。押すと打ちかけの末尾に Markdown の引用（`> …`）と空行を足し、入力欄にフォーカスを移す（カーソルは引用の下）。**送らない**（差分の行コメント #511 と同じで、足すだけ）。
- 判定と組み立ては `web/src/quoteReply.ts` の純粋関数（`quoteReply.test.ts`）: `quotable()`（**1 つの返答のバブルの中**だけ。自分の入力・待ちのバブル・バブルをまたいだ選択・空白だけには出さない）、`quoteText()`（行ごとに `> `、前後の空行と行末の空白を落とし、`QUOTE_MAX_CHARS`＝600 字で切って `…`）、`quoteInsert()`、`quoteButtonPosition()`（選択の下の左端。画面からはみ出さない）。
- 選択を読むのは `web/src/useQuoteSelection.ts`（`selectionchange`・スクロール・リサイズで読み直す）。**引用できるのは返答の本文（`.msg` の中の `.body`）だけ**で、一言（`.summary`。LLM の言い換えでエージェントの文ではない）・思考・時刻・使用量の印・ボタンの文字には出さない。側は `.msg` の `data-side`＝`agent`、待ちは `.waiting` で見る。**選択がチャットの見えている範囲から流れ出たら出さない**（`selectionVisible()`）。位置が変わらなければ state を触らない。**ボタンを押しても選択を外さない**（pointerdown / mousedown の既定を止める）。タッチ端末は押した瞬間に選択が外れてから click が届くので、外れてから消すまで `CLEAR_DELAY_MS`（250ms）待つ。
- `Chat` は `onQuote` を渡されたときだけ見る。渡すのは `SessionView` だけ（返信欄を出しているとき）で、フィード・要対応には出さない。`SessionView` が `quote`（`{ text, seq }`）を持ち、`ReplyBox` が `insert`（#511）と同じく **`seq` が増えたときだけ** `appendInsert()` で足す。`ReplyBox` は `key` でセッションごとに作り直され、作ったときの `seq` は当てた扱いにするので、別のセッションには持ち越さない。
- 入力欄はただの textarea のまま（引用をチップにしない）。箇条書きの項目ごとの印は出していない。

## ⌘K と検索

- `⌘K` の移動用モーダルは `CommandPalette` + `useCommandPalette`。候補の組み立てと絞り込みは `shared/palette.ts`（`paletteItems` / `filterPalette` / `paletteHash` / `moveIndex`）で、`shared/palette.test.ts` で回す。
- 開いたときに絞り込み無しの一覧を 1 回だけ取り直す（3 秒のポーリングには乗せない）ので、サイドバーの絞り込みで隠れているセッションも探せる。
- 候補は `<a href="#/...">` にして、`Enter` はその要素を `click()` する（hash を直接書き換えない。oxlint の `react/immutability` に当たる）。
- 発言の本文も探す（#230）。セッション名の候補は手元で即出し、その下に `GET /api/search` の結果を打ち終わってから（`web/src/useSearch.ts` の `SEARCH_DEBOUNCE_MS` = 250ms、2 文字から）足す。
- 当たりの判定と抜粋は `shared/search.ts` の純粋関数（`searchWords` / `matchesAll` / `excerptOf` / `splitHighlight`）。絞り込みの規則は `filterPalette` と同じにする。
- `useSearch` は「届いた結果」だけを state に持ち、「探し中か」は描画中に導く（effect の中で同期に setState する `react/set-state-in-effect` を避けるため。`focusLater` と同じ考え方）。
- 当たりを選ぶと `#/s/<id>?ts=<ts>&side=<who>` へ飛び、`Chat` が `data-ts` と `data-side` でその発言を探して `scrollIntoView` し、`.msg.found` で数秒光らせる（その間は最下部に追従しない）。

## 発言のメニュー（#503）

- 発言ごとの `⋯`（`web/src/MessageMenu.tsx`）から、検索の飛び先と同じ形のリンクと本文をコピーできる。組み立ては `web/src/messageLink.ts` の `messageUrl()` / `messageCopyText()`、光らせるのは `isFocused()`（`messageLink.test.ts`）。
- 発言を名指しする鍵は `ts` と側（`me` / `agent`）。`ts` だけだと 1 本の行から出る自分の入力と返答が同じ `ts` で区別できず、`Utterance.key` は位置（`index`）を含むので 7 日の窓が動くとずれる。
- リンクの頭は `location.origin`（ループバックなら `127.0.0.1`、Serve 越しならそのホスト）。本文は記録の `text` / `user_text` そのもので、自分の入力は `splitAttachments()` で画像のパスを外す。
- 待ちのバブルには出さない。ホバーで出し、ホバーの無い端末では常に出す（本文の右を空ける）。
- 一番下の発言で開くとパネルがチャットの箱の下にはみ出すので、開いたら `scrollIntoView({ block: 'nearest' })` で送る。

## セッション画面の 7 日の窓（#477）

- セッション画面は直近 7 日の行だけ描く（`shared/recentRows.ts` の `recentRows()`、詳細の API の `recent` / `focus` / `older`）。それより前は先頭の `OlderRowsButton`（「前の 7 日を表示（残り N 件）」）で 7 日ずつ広げる。
- 7 日は「いま」ではなくそのセッションの一番新しい行から数える（いまから数えると、しばらく触っていないセッションが空で開き、7 日以上前に止まった待ちのバブルまで消える）。
- 描かない行の人の入力は `older_prompts`（50 件まで）で運び、`replyHistory.ts` の `withOlder()` で ↑ の履歴の後ろに足す（履歴は描いている行から作るので、無いと 7 日より前の指示を呼び戻せない）。
- 広げても画面を空にしない（`usePolling` の `resetKey` に id だけを渡す。空にするとチャットが作り直されて読んでいた場所を失う）。
- 前の行が足されたら、足された高さぶん `scrollTop` を送り直す（`Chat` の `useLayoutEffect` と `chatScroll.ts` の `prepended()`）。ブラウザのスクロールアンカーは Safari に無く、先頭で押したときは Chrome でも効かない。
- 検索の飛び先（`focus`）は窓に関係なく含める（落とすと飛べない）。
- 返信が終わったかの判定に使う行数は、描いている行ではなく `session.turns`（集計）から数える（広げて行が増えたのを返信の終わりと取り違えない）。

## 最下部追従（#344 / #544）

- チャットの最下部追従は「中身の高さが変わったとき」だけ（判定は `web/src/chatScroll.ts` の `nearBottom()` / `followsBottom()`、`chatScroll.test.ts`）。
- 追従するか（`stickToBottom`）は `onScroll` が最下部まで `NEAR_BOTTOM_PX`（40px）未満かで決め、実際に送るのは最後に送ったときの `scrollHeight` と変わったときだけにする。`usePolling` は `rev` が同じでも `updatedAt` のために 3 秒ごとに state を更新し、`Chat` の `trailer` は毎描画で新しい要素なので、追従の effect は中身が変わっていなくても走るため。
- 箱の見えている高さ（`clientHeight`）が変わったときも、追従中なら送り直す（#544。`Chat` の `ResizeObserver` と `chatScroll.ts` の `followsResize()`）。差分ボタンは差分の有無を取ってから出て、そのぶん `.reply` の `margin-top` を広げる（#351）ので、最下部まで送ったあとで箱が縮む。入力欄が伸びたとき・キーボードが出たときも同じ。読み返している間と、検索の飛び先へ着く前は送らない。

## フィードの返信先から飛ぶ（#297）

- フィードでは返信先のチップ（`ReplyBox` の `.target`）の名前を押すと、そのセッションの最後の発言へ飛ぶ。飛び先は `web/src/feedJump.ts` の `lastUtteranceKey()`（エージェントの発言の一番新しいもの、無ければ自分の入力。`feedJump.test.ts`）。
- `ts` ではなくバブルの `Utterance.key`（`Message` の `data-key`）で指す（フィードは複数のセッションが混ざって `ts` が秒で重なり、1 行から自分の入力と返答が同じ `ts` で 2 つ出るため）。
- `Chat` の `jumpTo` は `{ key, seq }` で、`seq` が変わったときだけ送る（検索の `focusTs` は一度着地した `ts` に二度と送らないので、それとは別に持つ）。
- 光らせ直しは `.msg.found` を要素に直接付け直す（アニメーションは class を付け直さないと再生し直さない）。
- フィードに発言が無ければ `onJump` を渡さず、チップは押せない表示のまま。ボタンは mousedown を止めて入力欄のフォーカスを奪わない。

## Markdown

- `shared/markdown.ts` が `text` を木（`Block` / `Inline`）にし、`web/src/Markdown.tsx` が React 要素に組み立てる（HTML 文字列は作らない）。
- パーサは DOM 非依存なので `shared/markdown.test.ts` と `shared/emoji.test.ts` を node:test で回す。
- 一覧の `last_text` は同じファイルの `stripMarkdown()` で記号を落とす。

### 絵文字

- `:tada:` の絵文字も同じ行内解析で、名前 → 絵文字の表と `:` の検出・絞り込みは `shared/emoji.ts`（`lookupEmoji` / `emojiQuery` / `filterEmoji`）。
- 表に載っている名前だけを `emoji` ノードにするので、`14:08:30` のような時刻は文字のまま。

### 表（#328）

- GFM の表は `table` ノード。`|` を含む行の次が区切りの行（`splitRow()` のセルが全部 `:?-+:?`）で、列の数が見出しと同じときだけ表にし（`tableHead()`）、違えば今までどおり段落。開いている段落の途中でも始める（GitHub と同じ）。
- セルはエスケープされていない `|` で分けて `\|` を `|` に戻し（コードの中も）、列の過不足は `fitCells()` で見出しに合わせる。本文の行は空行・`|` の無い行・別のブロックの始まり（`isTableRow()`）で終わる。`|` の無い `---` は罫線のまま。
- 描画は `web/src/MarkdownTable.tsx`（`.table-wrap` の中だけ横に流す）。セルでは本文の `overflow-wrap: anywhere` / `word-break` を外す（継がせると狭い画面でセルが 1 文字幅まで縮んで縦に伸びる。代わりに `min-width`）。

### 長い本文の折りたたみ（#365 / #369）

- 長い本文（`Message.tsx` の `isLong()`。600 字か 9 行超）の折りたたみは、フィードでもセッション画面でも開いた状態で始める（`Chat` の `longOpen` → `Message` の `defaultOpen` → `useState(defaultOpen)`。`showThinking` / `thinkingOpen` と同じ、画面ごとの表示の指定）。
- ボタンは両方向のトグル。畳んだ状態は `Message` のローカルな state で、`key`（`${ts}:${index}`）が変わらない限りポーリングをまたいでも残る。
- `.clamped` は CSS で隠しているだけで Markdown の木も DOM も最初から全部作っているので、開いた状態で始めても組み立ての費用は変わらない。
- `useReveal(open)`（#119）は初期値を覚えてから比べるので、開いた状態で始めても mount では動かない。

## 画像

### 本文の中の画像（#321）

- 手元のファイルの画像への参照は `image` ノード: `![alt](パス)` と、リンク先が画像の拡張子の `[名前](パス)`（Codex はこの形で出す）。パスはスキーム（`:`）・空白・括弧を含まないものだけ（`LOCAL_IMAGE`）。外の URL の画像（`![alt](https://…)`）は `link` にして読み込まない。
- 画像そのものはサーバが配る（`GET /api/sessions/<id>/images/<key>`。`server/local/images.ts`）。`key` は `shared/images.ts` の `imageKey()`（本文に書かれたパスの FNV-1a。画面でも同期で作る）で、サーバはそのセッションのターン完了の行の `text` から `imageRefs()` で拾った表（`imageTable()`）を引くだけ（パスはリクエストから受けない。待ちの行は見ない）。
- 自分の入力（`user_text`）の画像の参照と地の文の画像のパスも表に入る（#504。`shared/gallery.ts` の `userImageSrcs()` を一覧と共用する）。
- 読むのは realpath が行の `cwd` の中（シンボリックリンク・`../` で外に出ない。`/tmp` も配らない）・中身が PNG / JPEG / GIF / WebP（`sniffImageType()`。SVG は同じオリジンで開くとスクリプトが動くので配らない）・20MB 以下のものだけ。`nosniff` と `CSP: sandbox` を付け、`?download=1` のときだけ `Content-Disposition: attachment`。別のマシンのセッションは 404。
- 画面は `Chat` がバブルごとに `ImageSourceContext`（`web/src/imageContext.ts`。URL を作る関数で、別のマシン・自分の入力は null）を渡し、`MarkdownImage` がサムネイル（押すとライトボックス）＋ダウンロードにする。口が無い・読めない（`onError`）ときは印と名前（`.md-image`）。
- **横に細長い画像（帯）**（#702）: `ThumbImage` が `onLoad` で絵の大きさを返し、`imageShape.ts` の `bandLayout()` が帯（幅の上限 `THUMB_WIDTH` = 320px まで縮めた高さが `BAND_MIN_HEIGHT` = 80px を切る = 4:1 以上）なら `{ cap, floor }` を返す。`MarkdownImage` が `.md-img.band` と `--cap`（高さ 80px になる幅。元の幅まで）・`--floor`（高さ `BAND_FLOOR_HEIGHT` = 18px になる幅）を付け、CSS が枠を `min(100%, --cap)`、絵を `max(100%, --floor)` にする（収まらなければ枠の中で横スクロール）。境目では今までと同じ大きさなので、縦横比で大きさが飛ばない。
- **押せる場所**（#702）: 包んでいる `<a>`（`.md-img > a:first-child`）が `min-width` / `min-height: 44px` を持ち、絵は縦の中央。幅の上限（320px）は絵でなくこの枠に持たせる（絵の `%` は枠の幅を指すので、絵に持たせると枠だけが広がる）。`imageShape.test.ts` が CSS の `320px` と `THUMB_WIDTH` を突き合わせる。
- **同じ発言の本文の画像を送る**（#702）: `Message` が `BodyImagesProvider`（本文と、読めなかった URL の集合）で包み、`MarkdownImage` は**押されたとき**に `bodyImages.ts` の `bodyImages()`（`imageRefs()` を URL にして、同じ URL は 1 つ・読めなかったものは除く）と `lightboxFrom()`（並びと自分の位置。並びに居なければ自分 1 枚）でライトボックスに渡す。描くたびに本文を解釈しない。
- 一言も `linkifyRefs()` → `parseInline()` を通るので同じく `image` になるが、一言の中は印と名前だけ（`Message` が context を null にする）で、画像は一言の下に元の本文から並べる（`SourceImages`。詳細を開いている間は本文の中に出るので出さない）。

### アバター（#666）

- バブルの左のアバターは `Avatar`（`kind` = `me` かエージェントの種類、`icon` があれば画像、無ければ `mark` の頭文字）の 1 つ。`Chat`・`ApprovalBubble`・`PendingBubble`・`QueuedBubble` が使う。**新しいバブルを足すときもこれを使う**（別々に書いていた頃は、許可のバブルと送ったメッセージへの返答が頭文字だけだった）。
- `Chat` の見出しの発言者は `chatGroups.ts` の `groupSpeaker()`。ふつうのバブルは `speakerLabel()` のまま、送ったメッセージへの返答（#588）は印の `to_name` / `to_icon`（無ければ一覧から引けたもの → 頭文字）。
- `to_icon` はサーバが詳細の応答で付ける（`agentReplyRows()` の第 4 引数。`iconStore.all()` から相手の ID で引くので、相手がアーカイブ済み・一覧の窓の外でもファイルがあれば出る）。行の形は変えていない（`agent_reply` は応答に付けるだけ）。
- `ApprovalBubble` には呼ぶ側がセッションのアイコンを渡す（`FeedView` は一覧から、`SessionView` はそのセッション、`TodoRow` は行のセッション。要対応ではバブルのアバターは CSS で隠れていて、行の名前の横のアイコンが出る）。

### バブルの下の画像（ギャラリー。#504 / #507）

- セッション画面では、画像を出てきた発言のバブルの下に足す（`useGallery` → `shared/gallery.ts` の `imagesByBubble()` → `Chat` の `images` → `MessageImages`。`GET /api/sessions/<id>/gallery`）。バブルの中にもう出ているもの＝返答の本文の画像と SAI の添付は除く。鍵は `bubbleKey(ts, user / agent)` で `Chat` の `data-ts` / `data-side` と同じ組。
- 行から拾うもの（返答・自分の入力・添付。`galleryFromRows()`）に、Claude の transcript の `image` ブロック（端末で貼った `[Image #N]` と Read で開いた画像。行には文字しか残らない）を `server/local/transcriptImages.ts` の `TranscriptImages` が足す。
- transcript の場所は `ProgressReader.claudeTranscript()`（行の cwd とセッション ID から）。画像は一覧で見つけた `<行の先頭のバイト位置>-<何枚目か>` の鍵でだけ配り（`/transcript-images/<key>`。パスも中身も受けない）、種類は中身から（SVG は配らない）。
- transcript は大きいので増えた分だけ読み足す（縮んだら最初から、書きかけの最後の行は次に回す）。
- 付ける行は `rowTsAtOrAfter(rows, at, from)`（その秒以降で一番古い、その側のバブルが出る行。貼った画像は自分の入力の行、Read で開いた画像はそのターンの返答の行）。待ちの行には付けない（待ちのバブルには画像を出さないので消える。#508 のレビュー）。
- 取るのは開いたときと新しい発言が記録されたとき（`useDiffSummary` と同じ形）。
- **フィードでも出す**（#657）。`FeedView` が `feedGallery.ts` の `galleryStamps()`（自分のマシンのセッション → 発言の出る一番新しい行の `ts`。新しい順に `FEED_GALLERY_MAX` 個まで）を `useGalleries` に渡し、目印が変わったセッションだけ `GET /api/sessions/<id>/gallery` を 1 つずつ順に取る（`useDiffSummaries` と同じ形。3 秒のポーリングには載せない）。`Chat` には `imagesBySession`（エンティティ ID → `bubbleKey` → 画像）で渡す。`bubbleKey` はセッションの中でだけ一意なので、**セッションで引いてから鍵で引く**（1 枚の Map に混ぜない）。ライトボックスの ← → は `MessageImages` が持つその発言の画像だけなので、別のセッションの画像へは送らない。
- **Codex の画像生成（`imagegen`）で作った画像も同じ一覧に足す**（#575。`server/local/codexImages.ts` の `CodexImages`、`source: 'generated'`）。画像は `CODEX_HOME/generated_images/<スレッド>/exec-<item id>.png` に保存され、返答の本文にもフックの payload にもパスが載らない。手がかりは rollout の `event_msg` の `item_completed`（`Extension` の `kind: image_gen.generation` の `id`、見せた画像の `ImageView` の `path`）なので、`ProgressReader.codexRollout()` で引いた rollout を `TranscriptImages` と同じく増えた分だけ読む。
- 生成した画像で拾うのは**そのスレッドの置き場の直下のファイルだけ**。配るのは一覧で見つけたファイル名の鍵だけ（`/codex-images/<key>`。スレッドの ID も鍵も名前 1 つぶんだけ・realpath がその置き場の中・中身で種類を判定して SVG は配らない）。付ける行は `rowTsAtOrAfter()`（作った時刻以降で一番古い返答の行）。置き場は `TerminalDeps.codexImages`（テストは一時ディレクトリ）。
- **`view_image` で見せた画像（`ImageView`）は、realpath が行の `cwd` の中にあるものも拾う**（#704。`source: 'viewed'`、名前はファイル名）。`imageMention()` は置き場の外の絶対パス（拡張子が png / jpg / jpeg / gif / webp のもの）を `path` で返し、cwd の中かは `list(rollout, thread, cwd)` が realpath で見る（`cwd` はセッションの行から。空なら拾わない）。cwd の外（`/tmp`）・外を指すシンボリックリンク・SVG・消えたファイルは一覧に載せない。
- 鍵は `view-<realpath とターンの sha256 の先頭 16 桁>.<拡張子>`（パスを載せない）。**ターンごとに別の鍵**にして、同じパスに撮り直して後のターンで見せ直した画像もそのターンのバブルに出す（同じターンの中の 2 回は 1 回。#707 のレビュー）。配るのは同じ `/codex-images/<key>` で、読むのは本文の画像と同じ `readSessionImage()`（realpath が cwd の中・リンクを辿らずに開く・中身で種類を判定）。
- **本文にも書かれている画像は足さない**（バブルの中にもう出る）。`app.ts` が `imageTable()` の参照を `realImagePath()` で realpath にして、同じファイルを除く（セッションの中のどの発言に書かれていても除く）。付ける行は生成した画像と同じ。

### 枠の軽い版（#589）

- `MessageImages` / `MarkdownImage` / `AttachedImages` の枠の `<img>` は `ThumbImage`（`src` は `shared/images.ts` の `thumbUrl()` = `?thumb=1`、`loading="lazy"`・`decoding="async"`）。**ライトボックスとダウンロードに渡すのは元の URL のまま**（`thumb.test.ts` がソースで見る）。
- `<img>` の `onError` からは状態が見えないので、同じ URL に HEAD を投げて `thumbFailure()`（`web/src/thumb.ts`）で見分ける: `503` + `X-SAI-Thumb: unavailable` なら画像の印・名前・大きさ（`formatImageBytes()`）だけを出し（包んでいる `<a>` を押せば元を開く）、`200` なら（見分けている間に出来た）1 回だけ URL を変えて読み直し、それ以外は親の `onBroken` で今までどおり「表示できません」。
- 送る前の入力欄の画像（`AttachmentStrip`）は手元で選んだばかりなので、軽い版にしない。

### ライトボックス（#507 / #509）

- 画像を押すとページの中のライトボックスで開く。`LightboxProvider` を `Chat` が持ち、`MarkdownImage` / `AttachedImages` / `MessageImages` が `LightboxContext` を読む。別のタブは開かない。⌘ クリック・中クリックは `opensInPage()` が見送ってブラウザの既定のまま。
- **画面より小さい画像は拡大する**（#702）: `<img>` の `onLoad` で元の大きさを `--nw` / `--nh` に、上限を `--up`（`lightbox.ts` の `LIGHTBOX_MAX_UPSCALE` = 3）に置き、CSS（`.lightbox-stage img.sized`）が幅を「枠の幅・元の幅 × 上限・高さの上限から逆算した幅」の最小にする（JS で画面を測らないので、窓の大きさを変えても追従する）。大きさはどの URL のものかと一緒に持ち、送ったあと前の画像の大きさを使わない。
- 読めなかった画像（`onError`）は「表示できません」の文にする（#702 のレビュー。枠の画像は `loading="lazy"` なので、まだ読んでいない壊れた画像は並びから外せていない）。
- Esc・背景・✕で閉じ、同じ発言の画像は ← → で送る。キーは document の capture で拾って止める（App の Esc＝「フィードへ」と ← →＝一覧との行き来まで動かないように）。
- 横にスライド（スワイプ・ドラッグ）しても送る（#509）。Pointer Events でタッチもマウスも同じ扱い、判定は `swipeStep()`＝横に `SWIPE_MIN_PX`（50px）以上かつ縦より横。動かしている間は画像が付いてくる。`touch-action: pan-y pinch-zoom` で縦のスクロールとピンチはブラウザに残す。
- 枠が pointer を捕まえるので:
  - ‹ › のボタンは捕まえない（捕まえると click がボタンに届かない）。
  - 閉じるかは押し始めた場所で決める（捕まえたあとの pointerup の target は常に枠なので、画像を押しただけで閉じてしまう）。
  - 閉じるのは pointerup ではなく click（pointerup で消すとタッチ端末があとから送る click が下のリンクやサムネイルに落ちる）。
- ピンチで拡大している間は送らない（`swipeAllowed(visualViewport.scale)`。`touch-action: auto` に戻して横スクロールに任せる。拡大した広いスクリーンショットの右側を読めなくなるため。#510 のレビュー）。

## 一覧の 2 行目（#300）

- 一覧の 2 行目（最後の発言）は `web/src/sessionPreview.ts` の `sessionPreview()` が決める（`sessionPreview.test.ts`）。
- ターンが 1 回以上終わったあとの自分の入力が最後のターン完了より新しければ自分の返信（`あなた: …`）、そうでなければ `turns > 1` のときにエージェントの返答（一言があればそれ。一言はエージェントの発言にだけ使う）。
- 自分の入力は 2 つから見る: SAI から送った返信（`replying.text`。どのエージェントでも送った瞬間に分かる。`failed` は見ない）と、集計の `SessionSummary.last_user_text` / `last_user_ts`（`aggregate.ts` が再開とターン完了の行の `user_text` の一番新しいものから作る。Claude は入力の行で先に届き、Codex / OpenCode はターン完了の行に載るので `last_turn_ts` と同じ時刻になり返答の方が出る）。
- `last_text` の意味は変えていない（一言の対応付けがターン完了の行を前提にしている）。
- 最初の指示は題名と同じ文になるだけなので出さない。

## テストと型検査

- web の `tsconfig.json` は `../shared/**/*.test.ts` と `src/**/*.test.ts` を除外している（画面のビルドに `node:test` の型を混ぜないため）。
- web 側のテストの型検査は `web/tsconfig.test.json`（`types: ["node", "vite/client"]`、`src/**/*.test.ts` だけ）が持ち、`pnpm typecheck` の 2 つ目で回る。
- shared 側のテストは `server/tsconfig.json` が `../shared` ごと拾う。
