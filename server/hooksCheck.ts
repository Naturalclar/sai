// `/setup-sai` の点検から呼ぶ（#567）。Claude Code のフックを README のあるべき一覧と突き合わせて、足りないものを出す。
// 画面のバナーと同じ判定（shared/hooks.ts の claudeHookGaps()、届くかは claudeHooks.ts の reachesRecord()）を使うので、
// スキルに規則を書き写さない。**読むだけ**で設定は書き換えない。
//   node server/hooksCheck.ts [settings.json ...]   省略すると ~/.claude/settings.json と ./.claude/settings.json
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeHookGaps, hookGapLabel } from '../shared/hooks.ts'
import { reachesRecord } from './local/claudeHooks.ts'

const paths = process.argv.slice(2).length ? process.argv.slice(2) : [join(homedir(), '.claude', 'settings.json'), join('.claude', 'settings.json')]
const settings: unknown[] = []
for (const p of paths) {
  try {
    settings.push(JSON.parse(readFileSync(p, 'utf-8')))
    console.log(`読んだ: ${p}`)
  } catch {
    console.log(`無い / 読めない: ${p}`)
  }
}
const gaps = claudeHookGaps(settings, reachesRecord())
if (gaps === null) {
  console.log('分からない: record.py に届くフックが 1 つも見つからない（ラッパーがこのシェルの PATH に無い・別の置き場で繋いでいる、など）')
} else if (gaps.length === 0) {
  console.log('揃っている: README「1. フックを向ける」のフックは全部 record.py に届いている')
} else {
  for (const g of gaps) console.log(`繋がっていない: ${hookGapLabel(g)}`)
}
