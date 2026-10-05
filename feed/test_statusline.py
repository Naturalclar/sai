#!/usr/bin/env python3
"""statusline.py のテスト。`python3 -m unittest feed.test_statusline` か直接実行。

押さえること:
- 何を食わせても exit 0（ステータスラインのコマンドが失敗すると TUI の表示が壊れる）
- `rate_limits` があれば usage-claude.json に**上書き**で書く（履歴は持たない）
- 戻る時刻を過ぎた窓は書かず、置いてある記録より古い `ts` では上書きしない（#683）
- AGENT_FEED_HOST を設定したときだけマシンごとに分ける（record.py の day_file と同じ規則）
- stdout がそのままステータスラインになるので、そこに出す1行も見る
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "statusline.py"

sys.path.insert(0, str(HERE))
import statusline  # noqa: E402

#: まだ戻っていない窓の `resets_at`（期限切れの窓は書かれないので、固定の数字にすると日が経てば落ちる）
FIVE_HOUR_RESETS = int(time.time()) + 3600
WEEK_RESETS = int(time.time()) + 86400


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
            "five_hour": {"used_percentage": 42.7, "resets_at": FIVE_HOUR_RESETS},
            "seven_day": {"used_percentage": 71, "resets_at": WEEK_RESETS},
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
        self.assertEqual(row["rate_limits"]["seven_day"]["resets_at"], WEEK_RESETS)
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

    def test_expired_windows_are_not_written(self):
        # 再開した古いセッションは、最後に受け取った rate_limits を持ち回る（#683）
        past = int(time.time()) - 60
        stale = {"five_hour": {"used_percentage": 90, "resets_at": past}, "seven_day": {"used_percentage": 80, "resets_at": past}}
        self.assertEqual(run(payload(rate_limits=stale), self.env).returncode, 0)
        self.assertFalse((self.dir / "usage-claude.json").exists(), "全部切れていれば作らない")

        run(payload(), self.env)
        before = (self.dir / "usage-claude.json").read_bytes()
        result = run(payload(rate_limits=stale), self.env)
        self.assertEqual((self.dir / "usage-claude.json").read_bytes(), before, "取れていた記録を、読む側が捨てる中身で置き換えない")
        self.assertIn("5時間 90%", result.stdout, "表示はそのセッションが持っている値のまま")

        # 片方だけ切れているときは、生きている窓だけを書く
        run(payload(rate_limits={"five_hour": {"used_percentage": 90, "resets_at": past}, "seven_day": {"used_percentage": 35, "resets_at": WEEK_RESETS}}), self.env)
        self.assertEqual(self.written()["rate_limits"], {"seven_day": {"used_percentage": 35.0, "resets_at": WEEK_RESETS}})

    def record_at(self, ahead: timedelta, windows: dict) -> dict:
        """`ts` が今から `ahead` だけ先の記録を置く"""
        row = {"v": 1, "ts": (datetime.now(timezone.utc) + ahead).isoformat(timespec="seconds"), "rate_limits": windows}
        (self.dir / "usage-claude.json").write_text(json.dumps(row), encoding="utf-8")
        return row

    def test_does_not_overwrite_a_newer_record(self):
        newer = self.record_at(timedelta(minutes=1), {"seven_day": {"used_percentage": 35, "resets_at": WEEK_RESETS}})
        self.assertEqual(run(payload(), self.env).returncode, 0)
        self.assertEqual(self.written(), newer, "ts が新しいほうを残す")
        self.assertEqual([p.name for p in self.dir.iterdir()], ["usage-claude.json"], "tmp を残さない")

    def test_overwrites_a_newer_record_that_would_freeze_the_usage(self):
        # 残すと、その時刻が来るまで割合が止まる（時計の狂ったマシンが書いた・窓がもう全部戻っている）
        past = int(time.time()) - 60
        for label, ahead, windows in (
            ("ts が先すぎる", timedelta(hours=1), {"seven_day": {"used_percentage": 35, "resets_at": WEEK_RESETS}}),
            ("窓が全部戻っている", timedelta(minutes=1), {"seven_day": {"used_percentage": 35, "resets_at": past}}),
            ("窓が無い", timedelta(minutes=1), {}),
        ):
            self.record_at(ahead, windows)
            self.assertEqual(run(payload(), self.env).returncode, 0, label)
            self.assertEqual(self.written()["rate_limits"]["seven_day"]["used_percentage"], 71.0, label)

    def test_overwrites_a_record_whose_ts_cannot_be_compared(self):
        path = self.dir / "usage-claude.json"
        for broken in ("壊れている", "[]", '{"ts": "いつ？"}', '{"ts": 5}', '{"ts": "2099-01-01T00:00:00"}'):
            path.write_text(broken, encoding="utf-8")
            self.assertEqual(run(payload(), self.env).returncode, 0, broken)
            self.assertEqual(self.written()["rate_limits"]["seven_day"]["used_percentage"], 71.0, broken)

    def test_live_windows_boundary_matches_the_reader(self):
        # 境界は shared/usage.test.ts の「書く側（feed/statusline.py）と同じ境界」と同じ形（#683）。片方だけ変えない
        now = datetime.fromtimestamp(1_800_000_000, timezone.utc)
        windows = {
            "five_hour": {"used_percentage": 1.0, "resets_at": 1_800_000_000.0},
            "seven_day": {"used_percentage": 2.0, "resets_at": 1_800_000_001.0},
        }
        self.assertEqual(list(statusline.live_windows(windows, now)), ["seven_day"], "ちょうど戻る時刻は期限切れ")
        self.assertEqual(statusline.live_windows({"five_hour": {"used_percentage": 1.0}}, now), {"five_hour": {"used_percentage": 1.0}}, "resets_at が無い窓は残す")


if __name__ == "__main__":
    unittest.main()
