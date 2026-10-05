# AGENTS.md

このリポジトリで動くエージェント（Codex / OpenCode など）向けの入口。決まりと部品の地図は [`CLAUDE.md`](CLAUDE.md)、詳細は `docs/` にある（ここには写さない）。コメント・コミットメッセージ・UI 文言は日本語で書く。

## SAI に画像を出す（#704）

- **返答の本文に `![名前](パス)` と書く。** 「貼りました」と書くだけ・`view_image` で開くだけでは、人が見ている SAI の画面に出ないことがある
- 置き場は **`.screenshots/`**（リポジトリの直下。`.gitignore` 済みなのでコミットされない）
- **`/tmp` と `web/dist/` は使わない。** SAI が配るのは作業ディレクトリの中の PNG / JPEG / GIF / WebP だけで、`web/dist/` は `pnpm build` で作り直されて消える
