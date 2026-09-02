interface Props {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
}

/** 「ラベル: すべて」を先頭に持つ絞り込み用 select */
export function FacetSelect({ label, value, options, onChange }: Props) {
  const list = value && !options.includes(value) ? [...options, value] : options
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{label}: すべて</option>
      {list.map((v) => (
        <option key={v} value={v}>{v}</option>
      ))}
    </select>
  )
}

export function DaysSelect({ value, options, onChange }: { value: string; options: number[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((n) => (
        <option key={n} value={String(n)}>直近{n}日</option>
      ))}
    </select>
  )
}
