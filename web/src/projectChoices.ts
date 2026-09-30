/**
 * 表示するリポジトリの候補（#215 / #529）。サイドバーの `FacetSelect` と同じ考え方で、
 * **いま選んでいるものが候補に無くても必ず並べる**（絞り込みの結果その日の行が 1 本も無いと
 * `facets.projects` から落ちるので、候補から消えると自分で解除できなくなる）。
 * 「すべて」（空文字）は呼び出し側が別に出す。
 */
export function projectChoices(projects: readonly string[], selected: readonly string[]): string[] {
  const list = projects.filter(Boolean)
  return [...list, ...selected.filter((p) => p && !list.includes(p))]
}
