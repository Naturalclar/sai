export function DaysSelect({ value, options, onChange }: { value: string; options: number[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((n) => (
        <option key={n} value={String(n)}>直近{n}日</option>
      ))}
    </select>
  )
}
