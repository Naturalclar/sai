// キーボードショートカットの一覧（#910）。`?` で開くパネル（ShortcutHelp.tsx）はここから描く。
// **キーの一覧はここの 1 か所だけ**に置く。キーを足したら、ここと docs/screen.md の両方に書く（shortcuts.test.ts が、
// ここのキーが docs/screen.md に `キー` の形で書かれているかを見る）。キーの動きそのものは各所の判定（sessionNav.ts・
// replyFocus.ts・approvalKeys.ts・paneKeys.ts など）が持っていて、ここは読むだけの一覧
//
// キーは Mac の書き方（`⌘` `⇧`）で書き、Mac 以外では `keyLabel()` が `Ctrl+` `Shift+` に直して見せる。

export interface Shortcut {
  /** 押すキー。並べたものは「どれでも」（`↑` と `k` など）。Mac の書き方で書く */
  keys: readonly string[]
  /** 何が起きるか */
  what: string
}

export interface ShortcutGroup {
  title: string
  /** 束の補足（効く場所の条件など） */
  note?: string
  items: readonly Shortcut[]
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: '移動',
    note: '入力欄の外で',
    items: [
      { keys: ['↑', '↓'], what: 'サイドバーの並びで上・下の項目へ' },
      { keys: ['k', 'j'], what: '同じ（vim 風）' },
      { keys: ['→'], what: '返信の入力欄へ' },
      { keys: ['Esc'], what: 'フィードへ戻る（差分を出していれば先に閉じる）' },
      { keys: ['⌘K'], what: '検索して移動（入力中も効く）' },
      { keys: ['⌘\\'], what: 'サイドバーを隠す・出す（入力中も効く）' },
      { keys: ['?'], what: 'この一覧を開く・閉じる' },
    ],
  },
  {
    title: '入力欄',
    items: [
      { keys: ['Enter'], what: '送る' },
      { keys: ['Shift+Enter'], what: '改行' },
      { keys: ['Esc'], what: '入力欄から外れる（打ちかけは消えない）' },
      { keys: ['←'], what: '本文が空なら一覧へ戻る' },
      { keys: ['↑', '↓'], what: '前に送った文を呼び出す' },
      { keys: ['→'], what: 'カーソルが末尾なら、薄く出た続きを入れる' },
      { keys: ['Tab'], what: '@ / : の候補を確定（Enter でも）' },
    ],
  },
  {
    title: '許可・質問',
    items: [
      { keys: ['⌘Enter'], what: '一番上の許可を許可' },
      { keys: ['⌘⇧Enter'], what: '常に許可（「常に許可」が無い許可では許可）' },
    ],
  },
  {
    title: 'ペイン',
    note: '広い画面で',
    items: [
      { keys: ['%'], what: '横に分ける' },
      { keys: ['h', 'l'], what: '左・右のペインへ' },
      { keys: ['x'], what: 'フォーカスのあるペインを閉じる' },
      { keys: ['Ctrl+1〜3'], what: 'その番号のペインの入力欄へ（入力中も効く）' },
      { keys: ['⌘Enter'], what: '⌘K の中で、選んだものを横に開く' },
    ],
  },
]

/** Mac か。`navigator.userAgentData.platform` があればそれ、無ければ `navigator.platform` を見る。分からなければ Mac 以外 */
export function isMacPlatform(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined): boolean {
  const name = nav?.userAgentData?.platform || nav?.platform || ''
  return /mac|iphone|ipad|ipod/i.test(name)
}

/** 見せるキーの文字。Mac 以外では `⌘` を `Ctrl+`、`⇧` を `Shift+` に直す（`⌘⇧Enter` → `Ctrl+Shift+Enter`） */
export function keyLabel(key: string, mac: boolean): string {
  if (mac) return key
  return key.replace('⌘', 'Ctrl+').replace('⇧', 'Shift+')
}

interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  isComposing: boolean
}

/**
 * キー入力で一覧のパネルをどうするか。
 * - `?` は入力欄の外（`typing` が false）でだけ。入力欄の中では今どおり文字として入る。配列によって Shift を伴うので Shift は見ない。
 *   ⌘ / Ctrl / Alt 付きと IME 変換中は何もしない
 * - 開いているときの `Esc` は閉じるだけ（呼び出し側が capture で止め、App の「フィードへ」には渡さない）
 * - `modal`（ほかのモーダルが出ている）ときは開かない。開いているパネル自身は呼び出し側で数えない
 */
export function helpAction(e: KeyLike, state: { typing: boolean; open: boolean; modal: boolean }): 'toggle' | 'close' | null {
  if (e.isComposing) return null
  if (state.open && e.key === 'Escape') return 'close'
  if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return null
  if (state.typing) return null
  if (!state.open && state.modal) return null
  return 'toggle'
}
