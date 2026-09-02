// vite.config.ts の define で埋め込まれる値の型
interface ImportMetaEnv {
  /** リポジトリの URL（package.json の repository）。ヘッダーの GitHub リンクに使う */
  readonly REPO_URL: string
}
