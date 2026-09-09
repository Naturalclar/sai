/**
 * フィードの見出しに出すリポジトリの候補（#215）。サイドバーの `FacetSelect` と同じ考え方で、
 * **いま選んでいるものが候補に無くても必ず並べる**（絞り込みの結果その日の行が 1 本も無いと
 * `facets.projects` から落ちるので、候補から消えると自分で解除できなくなる）。
 * 「すべて」（空文字）は呼び出し側が別に出す。
 */
export function projectChoices(projects: readonly string[], current: string): string[] {
  const list = projects.filter(Boolean)
  return current && !list.includes(current) ? [...list, current] : [...list]
}
