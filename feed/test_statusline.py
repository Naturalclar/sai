#!/usr/bin/env python3
"""statusline.py のテスト。`python3 -m unittest feed.test_statusline` か直接実行。

押さえること:
- 何を食わせても exit 0（ステータスラインのコマンドが失敗すると TUI の表示が壊れる）
- `rate_limits` があれば usage-claude.json に**上書き**で書く（履歴は持たない）
- AGENT_FEED_HOST を設定したときだけマシンごとに分ける（record.py の day_file と同じ規則）
- stdout がそのままステータスラインになるので、そこに出す1行も見る
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "statusline.py"


def run(stdin: str | None = None, env: dict | None = None):
    merged = dict(os.environ)
    merged.update(env or {})
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=stdin,
        capture_output=True,
        text=True,
        env=merged,
        timeout=30,
    )


def payload(**over) -> str:
    """Claude Code がステータスラインに渡す JSON（2.1.266 のスキーマから、使う分だけ）"""
    row = {
        "session_id": "5f3a…",
        "cwd": "/w",
        "model": {"id": "claude-opus-5", "display_name": "Opus 5"},
        "workspace": {"current_dir": "/w", "project_dir": "/w"},
        "rate_limits": {
            "five_hour": {"used_percentage": 42.7, "resets_at": 1788970000},
            "seven_day": {"used_percentage": 71, "resets_at": 1789000000},
        },
    }
    row.update(over)
    return json.dumps(row)


class StatusLineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.env = {"AGENT_FEED_DIR": str(self.dir)}
        self.addCleanup(self.tmp.cleanup)

    def written(self, name: str = "usage-claude.json") -> dict:
        return json.loads((self.dir / name).read_text(encoding="utf-8"))

    def test_records_rate_limits_and_prints_one_line(self):
        result = run(payload(), self.env)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "Opus 5 · 5時間 43% · 週 71%")
        row = self.written()
        self.assertEqual(row["v"], 1)
        self.assertEqual(row["model"], "claude-opus-5")
        self.assertEqual(row["session"], "5f3a…")
        self.assertEqual(row["rate_limits"]["five_hour"]["used_percentage"], 42.7)
        self.assertEqual(row["rate_limits"]["seven_day"]["resets_at"], 1789000000)
        self.assertTrue(row["ts"], "いつ時点の割合かが分からないと画面に出せない")

    def test_overwrites_instead_of_appending(self):
        run(payload(), self.env)
        run(payload(rate_limits={"five_hour": {"used_percentage": 90.0}}), self.env)
        row = self.written()
        self.assertEqual(row["rate_limits"]["five_hour"]["used_percentage"], 90.0)
        self.assertNotIn("seven_day", row["rate_limits"], "前の内容が残らない（いまの割合だけを見る）")
        self.assertEqual([p.name for p in self.dir.iterdir()], ["usage-claude.json"], "tmp を残さない")

    def test_host_splits_the_file_only_when_set(self):
        run(payload(), dict(self.env, AGENT_FEED_HOST="mbp.local"))
        self.assertEqual(self.written("usage-claude.mbp.json")["host"], "mbp")
        self.assertFalse((self.dir / "usage-claude.json").exists())

    def test_garbage_input_exits_zero_and_writes_nothing(self):
        for bad in ("", "ないよ", "[]", "null", '{"rate_limits": "たくさん"}'):
            result = run(bad, self.env)
            self.assertEqual(result.returncode, 0, bad)
            self.assertFalse((self.dir / "usage-claude.json").exists(), bad)

    def test_no_rate_limits_still_shows_the_model(self):
        # API キー利用や、最初の応答が返る前は rate_limits が載らない
        result = run(payload(rate_limits={}), self.env)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "Opus 5")
        self.assertFalse((self.dir / "usage-claude.json").exists())

    def test_percentage_without_number_is_dropped(self):
        run(payload(rate_limits={"five_hour": {"used_percentage": None}, "seven_day": {"used_percentage": 71}}), self.env)
        row = self.written()
        self.assertNotIn("five_hour", row["rate_limits"])
        self.assertEqual(row["rate_limits"]["seven_day"]["used_percentage"], 71.0)

    def test_skip_env_records_nothing(self):
        # SAI が一言を作るために回す claude に付く。表示はするが記録しない（record.py と同じ意味）
        result = run(payload(), dict(self.env, AGENT_FEED_SKIP="1"))
        self.assertEqual(result.returncode, 0)
        self.assertIn("5時間", result.stdout)
        self.assertFalse((self.dir / "usage-claude.json").exists())

    def test_makes_the_feed_dir_if_missing(self):
        env = {"AGENT_FEED_DIR": str(self.dir / "まだ無い")}
        self.assertEqual(run(payload(), env).returncode, 0)
        self.assertTrue((self.dir / "まだ無い" / "usage-claude.json").exists())


if __name__ == "__main__":
    unittest.main()
