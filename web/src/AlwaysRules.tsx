interface Props {
  /** 書かれるルールの表記（`Bash(pnpm test:*)`）。サーバが組んだもの */
  rules: string[]
  /** [常に許可] を押したあと */
  done: boolean
}

/**
 * [常に許可] を押すと何を許可することになるか（#705）。つないだコマンド（`cd dir && pnpm test && pnpm lint`）は部品ごとに
 * ルールを書くので、**押す前に全部見せる**（前はボタンの title にしか無く、携帯では見えなかった）。
 * `cd` と読むだけのコマンドはルールが要らないので並ばない
 */
export function AlwaysRules({ rules, done }: Props) {
  return (
    <div className="always-rules">
      <span className="lead">{done ? '書いたルール' : '「常に許可」で書くルール'}</span>
      {rules.map((rule) => (
        <code key={`always:${rule}`}>{rule}</code>
      ))}
      {!done && <span className="tail">このディレクトリでは、この形を今後聞かれなくなります</span>}
    </div>
  )
}
