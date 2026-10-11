// #780。一覧は手で書かず、符号の表から引き直したものと突き合わせる。
// 日本語でも使う字が 1 つ混ざるだけで、ほぼ全部の一言に当たる検査になるため
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHINESE_ONLY_EXTRA, CHINESE_ONLY_HAN } from './chineseOnlyHan.ts'

function decode(encoding: string, bytes: number[]): string {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(Uint8Array.from(bytes))
  } catch {
    return ''
  }
}

const isHan = (c: string) => /^\p{Script=Han}$/u.test(c)

/** JIS X 0208（EUC-JP の 2 バイト・Shift_JIS）と JIS X 0212（EUC-JP の 3 バイト）の漢字 */
function jisHan(): Set<string> {
  const out = new Set<string>()
  const add = (c: string) => {
    if (isHan(c)) out.add(c)
  }
  for (let a = 0xa1; a <= 0xfe; a++) {
    for (let b = 0xa1; b <= 0xfe; b++) {
      add(decode('euc-jp', [a, b]))
      add(decode('euc-jp', [0x8f, a, b]))
    }
  }
  for (let a = 0x81; a <= 0xfc; a++) for (let b = 0x40; b <= 0xfc; b++) add(decode('shift_jis', [a, b]))
  return out
}

/** GB 2312 の第一水準（区 16〜55）の漢字 */
function gbLevel1(): string[] {
  const out: string[] = []
  for (let a = 0xb0; a <= 0xd7; a++) {
    for (let b = 0xa1; b <= 0xfe; b++) {
      const c = decode('gb2312', [a, b])
      if (isHan(c)) out.push(c)
    }
  }
  return out
}

/**
 * JIS X 0208 / 0212 には無いが、JIS X 0213 にはある字（旧字体や異体字。人名などで日本語の文にも出る）。
 * Node は JIS X 0213 を読めないので、ここだけは一覧で持つ（Python の `euc_jis_2004` で引いた）
 */
const IN_JIS_X_0213 = '么俱傈傣傻僳关养卧吞呕噶复岭巢开惮揭摹晚步每毗沪泻涉渗渴烬瞩种筹肤荣踌阴'

test('一覧は、GB 2312 第一水準のうち JIS の表に無い字とちょうど同じ', () => {
  const jis = jisHan()
  const gb = gbLevel1()
  assert.equal(gb.length, 3755, 'GB 2312 の表が読めている')
  assert.ok(jis.size > 6000, 'JIS の表が読めている')
  const dropped = new Set(IN_JIS_X_0213)
  const want = gb.filter((c) => !jis.has(c) && !dropped.has(c)).sort().join('')
  assert.equal(CHINESE_ONLY_HAN, want)
  for (const c of IN_JIS_X_0213) assert.ok(gb.includes(c) && !jis.has(c), `${c} は外す理由のある字`)
})

test('手で足した字は、機械で引いた一覧と重ならない', () => {
  for (const c of CHINESE_ONLY_EXTRA) assert.ok(!CHINESE_ONLY_HAN.includes(c), c)
  assert.equal(new Set(CHINESE_ONLY_HAN).size, [...CHINESE_ONLY_HAN].length, '同じ字を 2 回置いていない')
})

test('日本語でも使う字は 1 つも入っていない（新字体と簡体字で形が同じもの・JIS にある字）', () => {
  const all = CHINESE_ONLY_HAN + CHINESE_ONLY_EXTRA
  // 手で作った一覧に混ぜて、8 件を 81 件と数え違えた字
  for (const c of '区台届当参号声担') assert.ok(!all.includes(c), c)
  // 新字体と簡体字が同じ形の字（どれも日本語の文に普通に出る）
  for (const c of '国会学体点万与写双旧党乱宝来虫医独献灯辞尽状麦礼装条寿栄労') assert.ok(!all.includes(c), c)
  // 逆に、形の違う簡体字は入っている（日本の字体は 対・実・検）
  for (const c of '对实检') assert.ok(all.includes(c), c)
})
