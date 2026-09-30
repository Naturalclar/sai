// 表示するリポジトリの絞り込み（#529）。前は 1 つだけ（`filters.project: string`）だったのを、**複数**選べるようにする。
// 空の配列が「すべて」。選んだどれか 1 つに当たれば出す（OR）。
//
// サーバ（`/api/sessions` / `/api/feed` の `?project=a&project=b`）と画面（サイドバー・フィードの見出し）が
// 同じ関数を使う。DOM にもサーバにも依存しない（projectFilter.test.ts）。

import { projectName } from './project.ts'

/** 空を落として重複を除く（並びは最初に出てきた順） */
export function cleanProjects(values: readonly unknown[]): string[] {
  const out: string[] = []
  for (const v of values) {
    const p = typeof v === 'string' ? v.trim() : ''
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/**
 * localStorage に残っている絞り込みから、選んでいるリポジトリを読む。
 * #529 より前は `project: 'Naturalclar/sai'`（1 つの文字列）で持っていたので、そちらしか無ければ引き継ぐ
 * （開き直したら「すべて」に戻っていた、にしない）。壊れていれば空（すべて）
 */
export function storedProjects(stored: { projects?: unknown; project?: unknown }): string[] {
  if (Array.isArray(stored.projects)) return cleanProjects(stored.projects)
  return typeof stored.project === 'string' ? cleanProjects([stored.project]) : []
}

/** そのセッション（行）のリポジトリが、選んだどれかに当たるか。何も選んでいなければ全部通す */
export function matchesProjects(selected: readonly string[], projects: readonly string[]): boolean {
  return selected.length === 0 || projects.some((p) => selected.includes(p))
}

/** 1 つを入れ外しした集合。並びは選んだ順（閉じているときの表示の先頭が変わらないように） */
export function toggleProject(selected: readonly string[], project: string): string[] {
  return selected.includes(project) ? selected.filter((p) => p !== project) : [...selected, project]
}

/** 閉じているときの短い表示。なし → 全リポジトリ、1 つ → `#sai`、複数 → `#sai +2` */
export function projectsLabel(selected: readonly string[]): string {
  if (selected.length === 0) return '全リポジトリ'
  const head = `#${projectName(selected[0]!)}`
  return selected.length === 1 ? head : `${head} +${selected.length - 1}`
}
