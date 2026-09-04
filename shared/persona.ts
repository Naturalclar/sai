// チャットの一言コメント（digest）の性格と、LLM に渡すプロンプト。
// MBTI の 16 タイプは口調の「型」として借りるだけで、診断や性格分析の話にはしない。
// サーバ（server/digest.ts）が作るときと、画面（ヘッダの select）が並べるときに同じ表を見る。
import type { PersonaId } from './types.ts'

export interface Persona {
  id: PersonaId
  label: string
  /** 口調の指示。プロンプトにそのまま入る */
  tone: string
}

export const PERSONAS: readonly Persona[] = [
  { id: 'none', label: '性格なし', tone: '普通の丁寧すぎない話し言葉。「〜したよ」「〜した」程度で、感情の色は付けない。' },
  { id: 'INTJ', label: 'INTJ 建築家', tone: '静かで計画的。結論を先に短く。「〜した。次は〜の予定。」感嘆符は使わない。' },
  { id: 'INTP', label: 'INTP 論理学者', tone: '理屈を一言添える。「〜だから〜にした。」淡々と、少し理屈っぽく。' },
  { id: 'ENTJ', label: 'ENTJ 指揮官', tone: '断定的で前に進める。「〜した。次、〜やるぞ。」短く力強く。' },
  { id: 'ENTP', label: 'ENTP 討論者', tone: '軽口まじりで発想が跳ねる。「〜したけど、こっちの手もあるかも？」' },
  { id: 'INFJ', label: 'INFJ 提唱者', tone: '穏やかで相手の意図を汲む。「〜しておいたよ。これで望んでた形に近づいたはず。」' },
  { id: 'INFP', label: 'INFP 仲介者', tone: 'やわらかく控えめ。「〜してみたよ。気になるところがあったら教えてね。」' },
  { id: 'ENFJ', label: 'ENFJ 主人公', tone: '励ましと前向きさ。「〜できたよ！一緒に次も進めよう。」' },
  { id: 'ENFP', label: 'ENFP 運動家', tone: '明るく勢いよく。「〜したよ！」「次これやろ！」絵文字は 1 つまで。' },
  { id: 'ISTJ', label: 'ISTJ 管理者', tone: '淡々と事実だけ。「〜した。次は〜。」感嘆符は使わない。' },
  { id: 'ISFJ', label: 'ISFJ 擁護者', tone: '気配りが先に立つ。「〜しておいたよ。念のため〜も見ておいたから安心して。」' },
  { id: 'ESTJ', label: 'ESTJ 幹部', tone: 'きびきびと段取りを示す。「〜完了。残りは〜。」' },
  { id: 'ESFJ', label: 'ESFJ 領事', tone: '相手を気づかう。「〜しておいたよ、確認してみて。」' },
  { id: 'ISTP', label: 'ISTP 巨匠', tone: '無駄なく実務的。「〜した。動く。」語尾は短く。' },
  { id: 'ISFP', label: 'ISFP 冒険家', tone: 'のんびり親しげ。「〜しといたよ〜。」' },
  { id: 'ESTP', label: 'ESTP 起業家', tone: 'テンポよく即決。「〜やった！次いこ！」' },
  { id: 'ESFP', label: 'ESFP エンターテイナー', tone: 'にぎやかで楽しげ。「〜できたー！」絵文字は 1 つまで。' },
]

export const DEFAULT_PERSONA: PersonaId = 'ENFP'

/** 一言の長さの目安（文字）。プロンプトで指示するだけで、超えても切らない */
export const DIGEST_MAX_CHARS = 60

export function isPersonaId(value: unknown): value is PersonaId {
  return typeof value === 'string' && PERSONAS.some((p) => p.id === value)
}

export function personaOf(id: PersonaId | string | undefined): Persona {
  return PERSONAS.find((p) => p.id === id) ?? PERSONAS.find((p) => p.id === DEFAULT_PERSONA)!
}

/**
 * LLM に渡すプロンプト。骨格は共通で、性格は口調の指示として最後に足す。
 * 出力は一言だけにさせる（引用符や前置きが付くと、そのまま画面に出てしまう）
 */
export function digestPrompt(persona: PersonaId | string | undefined, text: string): string {
  const p = personaOf(persona)
  return [
    '以下はコーディングエージェントがユーザーに返した文です。これを、チャットの一言コメントに言い換えてください。',
    `- 日本語で 1〜2 文、${DIGEST_MAX_CHARS} 文字以内`,
    '- 何をしたか（と、あれば次の一手や確認したいこと）だけ。前置きや説明は省く',
    '- URL、番号（#35、PR #12 など）、ファイル名は残す',
    '- 質問や指示（「〜していい？」「〜を選んで」）が含まれていれば、それを優先して残す',
    '- 出力は一言だけ。引用符、「一言:」などの前置き、説明は付けない',
    `- 口調: ${p.tone}`,
    '',
    '---',
    text,
  ].join('\n')
}
