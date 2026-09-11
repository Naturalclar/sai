import type { Block, TableAlign } from '../../shared/markdown.ts'
import { Inlines } from './Inlines'

type Table = Extract<Block, { kind: 'table' }>

const alignStyle = (align: TableAlign | undefined) => (align ? { textAlign: align } : undefined)

/**
 * Markdown の表（#328）。セルの中身は本文と同じ `Inlines`（コード・太字・リンク・絵文字・画像）。
 * 横に長い表は枠（`.table-wrap`）の中だけで横に流し、ページもバブルも広げない
 */
export function MarkdownTable({ table }: { table: Table }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {table.head.map((cell, i) => (
              <th key={i} style={alignStyle(table.align[i])}>
                <Inlines nodes={cell} />
              </th>
            ))}
          </tr>
        </thead>
        {table.rows.length > 0 && (
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, i) => (
                  <td key={i} style={alignStyle(table.align[i])}>
                    <Inlines nodes={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  )
}
