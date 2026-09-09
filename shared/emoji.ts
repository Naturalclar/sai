// Slack と同じ `:tada:` の記法で絵文字を出すための表と道具。
// 使うのは 2 か所で、どちらも同じ表を引く:
//   - 表示: shared/markdown.ts の parseInline() が `:name:` を Inline の emoji ノードにする
//   - 入力: web/src/ReplyBox.tsx が `:` を打った時に候補を出す（@ のメンション、/ のスキルと同じメニュー）
// 依存ゼロ・DOM 非依存なので node:test で回せる（shared/emoji.test.ts）。
//
// 表は「よく使うものだけ」の手書き。全部（GitHub 互換で 1,800 件ほど）を載せると web のバンドルが
// 40kB ほど増えるので、まずは実用の範囲から始める。増やすときはこの表に足すだけでよい。
// 名前は GitHub / Slack の呼び方に合わせる（`+1`、`tada`、`eyes` など）。

/** `:name:` → 絵文字。名前は小文字・数字・`_`・`+`・`-` だけ */
export const EMOJI: Readonly<Record<string, string>> = {
  // 反応・合図
  '+1': '👍',
  '-1': '👎',
  ok: '🙆',
  ok_hand: '👌',
  clap: '👏',
  raised_hands: '🙌',
  pray: '🙏',
  muscle: '💪',
  wave: '👋',
  point_up: '☝️',
  point_right: '👉',
  point_left: '👈',
  point_down: '👇',
  eyes: '👀',
  ear: '👂',
  brain: '🧠',
  handshake: '🤝',
  writing_hand: '✍️',
  // 顔
  smile: '😄',
  smiley: '😃',
  grin: '😁',
  laughing: '😆',
  joy: '😂',
  rofl: '🤣',
  sweat_smile: '😅',
  wink: '😉',
  blush: '😊',
  yum: '😋',
  sunglasses: '😎',
  heart_eyes: '😍',
  thinking: '🤔',
  neutral_face: '😐',
  expressionless: '😑',
  no_mouth: '😶',
  smirk: '😏',
  unamused: '😒',
  sweat: '😓',
  disappointed: '😞',
  pensive: '😔',
  confused: '😕',
  worried: '😟',
  cry: '😢',
  sob: '😭',
  scream: '😱',
  fearful: '😨',
  cold_sweat: '😰',
  weary: '😩',
  tired_face: '😫',
  triumph: '😤',
  rage: '😡',
  angry: '😠',
  innocent: '😇',
  upside_down_face: '🙃',
  zany_face: '🤪',
  exploding_head: '🤯',
  face_with_monocle: '🧐',
  nerd_face: '🤓',
  sleeping: '😴',
  sleepy: '😪',
  mask: '😷',
  robot: '🤖',
  ghost: '👻',
  alien: '👽',
  see_no_evil: '🙈',
  hear_no_evil: '🙉',
  speak_no_evil: '🙊',
  bow: '🙇',
  shrug: '🤷',
  facepalm: '🤦',
  raising_hand: '🙋',
  no_good: '🙅',
  person_with_pouting_face: '🙎',
  // 祝う・盛り上がる
  tada: '🎉',
  confetti_ball: '🎊',
  sparkles: '✨',
  star: '⭐',
  star2: '🌟',
  fire: '🔥',
  boom: '💥',
  zap: '⚡',
  rocket: '🚀',
  trophy: '🏆',
  medal: '🏅',
  crown: '👑',
  gift: '🎁',
  balloon: '🎈',
  cake: '🎂',
  '100': '💯',
  heart: '❤️',
  broken_heart: '💔',
  sparkling_heart: '💖',
  // 状態・印
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  x: '❌',
  o: '⭕',
  warning: '⚠️',
  no_entry: '⛔',
  no_entry_sign: '🚫',
  question: '❓',
  grey_question: '❔',
  exclamation: '❗',
  bangbang: '‼️',
  bulb: '💡',
  wrench: '🔧',
  hammer: '🔨',
  hammer_and_wrench: '🛠️',
  gear: '⚙️',
  nut_and_bolt: '🔩',
  lock: '🔒',
  unlock: '🔓',
  key: '🔑',
  mag: '🔍',
  bug: '🐛',
  beetle: '🪲',
  broom: '🧹',
  wastebasket: '🗑️',
  recycle: '♻️',
  construction: '🚧',
  hourglass: '⏳',
  alarm_clock: '⏰',
  stopwatch: '⏱️',
  watch: '⌚',
  clock: '🕐',
  calendar: '📅',
  pushpin: '📌',
  paperclip: '📎',
  link: '🔗',
  bookmark: '🔖',
  label: '🏷️',
  // 開発まわり
  computer: '💻',
  desktop_computer: '🖥️',
  keyboard: '⌨️',
  floppy_disk: '💾',
  package: '📦',
  books: '📚',
  book: '📖',
  memo: '📝',
  page_facing_up: '📄',
  clipboard: '📋',
  chart_with_upwards_trend: '📈',
  chart_with_downwards_trend: '📉',
  bar_chart: '📊',
  test_tube: '🧪',
  microscope: '🔬',
  telescope: '🔭',
  satellite: '🛰️',
  electric_plug: '🔌',
  battery: '🔋',
  signal_strength: '📶',
  iphone: '📱',
  camera: '📷',
  mag_right: '🔎',
  scroll: '📜',
  file_folder: '📁',
  open_file_folder: '📂',
  card_index_dividers: '🗂️',
  // 進む・向き
  arrow_right: '➡️',
  arrow_left: '⬅️',
  arrow_up: '⬆️',
  arrow_down: '⬇️',
  arrows_counterclockwise: '🔄',
  repeat: '🔁',
  fast_forward: '⏩',
  rewind: '⏪',
  arrow_forward: '▶️',
  pause_button: '⏸️',
  stop_button: '⏹️',
  // 生きもの・自然
  cat: '🐱',
  dog: '🐶',
  penguin: '🐧',
  whale: '🐳',
  snake: '🐍',
  turtle: '🐢',
  rabbit: '🐰',
  bear: '🐻',
  panda_face: '🐼',
  fox_face: '🦊',
  unicorn: '🦄',
  bird: '🐦',
  chicken: '🐔',
  sheep: '🐑',
  seedling: '🌱',
  herb: '🌿',
  four_leaf_clover: '🍀',
  cherry_blossom: '🌸',
  maple_leaf: '🍁',
  sunny: '☀️',
  cloud: '☁️',
  umbrella: '☔',
  snowflake: '❄️',
  rainbow: '🌈',
  ocean: '🌊',
  mountain: '⛰️',
  earth_asia: '🌏',
  crescent_moon: '🌙',
  // 食べもの・飲みもの
  coffee: '☕',
  tea: '🍵',
  beer: '🍺',
  beers: '🍻',
  wine_glass: '🍷',
  sake: '🍶',
  ramen: '🍜',
  sushi: '🍣',
  rice_ball: '🍙',
  bento: '🍱',
  curry: '🍛',
  pizza: '🍕',
  hamburger: '🍔',
  fries: '🍟',
  doughnut: '🍩',
  cookie: '🍪',
  candy: '🍬',
  chocolate_bar: '🍫',
  apple: '🍎',
  watermelon: '🍉',
  strawberry: '🍓',
  banana: '🍌',
  // そのほか
  eyeglasses: '👓',
  bell: '🔔',
  no_bell: '🔕',
  loudspeaker: '📢',
  mega: '📣',
  speech_balloon: '💬',
  thought_balloon: '💭',
  zzz: '💤',
  dash: '💨',
  droplet: '💧',
  sweat_drops: '💦',
  poop: '💩',
  skull: '💀',
  jack_o_lantern: '🎃',
  christmas_tree: '🎄',
  snowman: '⛄',
  santa: '🎅',
  house: '🏠',
  office: '🏢',
  hospital: '🏥',
  school: '🏫',
  train: '🚃',
  airplane: '✈️',
  car: '🚗',
  bike: '🚲',
  ship: '🚢',
  anchor: '⚓',
  soccer: '⚽',
  baseball: '⚾',
  basketball: '🏀',
  dart: '🎯',
  game_die: '🎲',
  video_game: '🎮',
  musical_note: '🎵',
  guitar: '🎸',
  art: '🎨',
  clapper: '🎬',
  circus_tent: '🎪',
  crystal_ball: '🔮',
  gem: '💎',
  moneybag: '💰',
  dollar: '💵',
  credit_card: '💳',
  scales: '⚖️',
  shield: '🛡️',
  crossed_swords: '⚔️',
  dizzy: '💫',
  cyclone: '🌀',
  hole: '🕳️',
  footprints: '👣',
}

/** 名前として通る形。`:` の内側に来られる文字だけ */
export const EMOJI_NAME = /^[a-z0-9_+-]+$/

/** 候補に出す数の上限。多すぎるとメニューが画面を覆う */
export const EMOJI_LIMIT = 20

/** `:` を打ち始めてから候補を出すまでに要る文字数。`10:30` のような文字列でいきなり開かないため */
export const EMOJI_MIN_QUERY = 2

/** 名前 → 絵文字。表に無ければ undefined（呼び出し側はただの文字として扱う） */
export function lookupEmoji(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(EMOJI, name) ? EMOJI[name] : undefined
}

export interface EmojiHit {
  name: string
  char: string
}

/**
 * 入力欄の caret 位置から見て、いま打ちかけの `:名前`。
 * `mentionQuery()` / `slashQuery()` と同じ形で開始位置と検索語を返す。
 * caret より前の最後の `:` を見て、そこから caret までが名前として通る形で EMOJI_MIN_QUERY 文字以上なら当たり。
 * `https://` は `:` の後ろが `//` で名前の形にならないので開かない。`10:30` は形は通るが
 * 当たる絵文字が無いので、呼び出し側（候補が空なら開かない）で閉じたままになる
 */
export function emojiQuery(text: string, caret: number): { start: number; query: string } | null {
  const head = text.slice(0, caret)
  const start = head.lastIndexOf(':')
  if (start < 0) return null
  const query = head.slice(start + 1)
  if (query.length < EMOJI_MIN_QUERY || !EMOJI_NAME.test(query)) return null
  return { start, query }
}

/** 検索語で絞る。名前の先頭に来るものを先、その後ろに部分一致。同じ組の中は名前順 */
export function filterEmoji(query: string, limit = EMOJI_LIMIT): EmojiHit[] {
  const q = query.toLowerCase()
  const prefix: EmojiHit[] = []
  const rest: EmojiHit[] = []
  for (const name of Object.keys(EMOJI).sort()) {
    if (!name.includes(q)) continue
    ;(name.startsWith(q) ? prefix : rest).push({ name, char: EMOJI[name]! })
  }
  return [...prefix, ...rest].slice(0, limit)
}
