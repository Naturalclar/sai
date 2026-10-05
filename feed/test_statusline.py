#!/usr/bin/env python3
"""statusline.py のテスト。`python3 -m unittest feed.test_statusline` か直接実行。

押さえること:
- 何を食わせても exit 0（ステータスラインのコマンドが失敗すると TUI の表示が壊れる）
- `rate_limits` があれば usage-claude.json に置き直す（履歴は持たない）
- 窓ごとに新しいほうを残す: 同じ窓は高いほう・来なかった窓は持ち越す・変わらなければ書かない（#689）
- 戻る時刻を過ぎた窓は書かず、置いてある記録より古い `ts` では上書きしない（#683）
- AGENT_FEED_HOST を設定したときだけマシンごとに分ける（record.py の day_file と同じ規則）
- stdout がそのままステータスラインになるので、そこに出す1行も見る
- `AGENT_FEED_DEBUG=1` のときだけ描画ごとの入力の要点を残す。本文・パスは残さない（#694）
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
        # AGENT_FEED_DEBUG は空にする（シェルに置いてあると、どのテストでも statusline-debug.log が出来る）
        self.env = {"AGENT_FEED_DIR": str(self.dir), "AGENT_FEED_DEBUG": ""}
        self.addCleanup(self.tmp.cleanup)

    def written(self, name: str = "usage-claude.json") -> dict:
        return json.loads((self.dir / name).read_text(encoding="utf-8"))

    def windows(self) -> dict:
        """書かれた窓から `changed_at`（その窓が最後に変わった時刻）を外したもの"""
        return {name: {k: v for k, v in window.items() if k != "changed_at"} for name, window in self.written()["rate_limits"].items()}

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

    def test_replaces_the_file_instead_of_appending(self):
        run(payload(), self.env)
        run(payload(rate_limits={"five_hour": {"used_percentage": 90.0, "resets_at": FIVE_HOUR_RESETS}}), self.env)
        row = self.written()
        self.assertEqual(row["rate_limits"]["five_hour"]["used_percentage"], 90.0)
        self.assertEqual(row["rate_limits"]["seven_day"]["used_percentage"], 71.0, "来なかった窓は持ち越す（#689）")
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

    def debug_lines(self) -> list:
        text = (self.dir / statusline.DEBUG_FILE).read_text(encoding="utf-8")
        return [json.loads(line) for line in text.splitlines()]

    def test_debug_is_off_unless_asked(self):
        run(payload(), self.env)
        self.assertFalse((self.dir / statusline.DEBUG_FILE).exists())

    def test_debug_appends_one_line_per_render(self):
        env = dict(self.env, AGENT_FEED_DEBUG="1")
        run(payload(version="2.1.287", cost={"total_api_duration_ms": 1200, "total_cost_usd": 0.5}), env)
        run(json.dumps({"session_id": "s2", "model": {"id": "claude-opus-5"}}), env)
        first, second = self.debug_lines()
        self.assertEqual(first["session"], "5f3a…")
        self.assertEqual(first["version"], "2.1.287")
        self.assertEqual(first["model"], "claude-opus-5")
        self.assertEqual(first["api_ms"], 1200.0)
        self.assertTrue(first["has_rate_limits"])
        self.assertEqual(first["rate_limits"]["seven_day"], {"used_percentage": 71, "resets_at": WEEK_RESETS})
        self.assertIn("rate_limits", first["keys"])
        self.assertFalse(first["skip"])
        self.assertFalse(second["has_rate_limits"], "載らなかった描画も 1 行（割合を出すのに要る）")
        self.assertIsNone(second["rate_limits"])
        self.assertIsNone(second["api_ms"])
        self.assertEqual(second["keys"], ["model", "session_id"])

    def test_debug_keeps_no_text_or_paths(self):
        env = dict(self.env, AGENT_FEED_DEBUG="1")
        secret = "ひみつ" * 40
        row = json.loads(payload(cwd="/Users/someone/private-project", transcript_path="/Users/someone/t.jsonl"))
        row["workspace"] = {"current_dir": "/Users/someone/private-project"}
        row["rate_limits"]["note"] = secret
        row["rate_limits"]["list"] = [secret]
        row[secret] = 1
        result = run(json.dumps(row), env)
        self.assertEqual(result.returncode, 0)
        text = (self.dir / statusline.DEBUG_FILE).read_text(encoding="utf-8")
        self.assertNotIn("private-project", text)
        self.assertNotIn("t.jsonl", text)
        self.assertNotIn(secret, text, "長い文字列は切る")
        self.assertEqual(self.debug_lines()[0]["rate_limits"]["list"], "<list 1>")

    def test_debug_also_logs_skipped_and_garbage_renders(self):
        # 記録（usage-claude.json）はしないが、調べるための行は残す
        env = dict(self.env, AGENT_FEED_DEBUG="1", AGENT_FEED_SKIP="1")
        self.assertEqual(run(payload(), env).returncode, 0)
        self.assertEqual(run("ないよ", env).returncode, 0)
        first, second = self.debug_lines()
        self.assertTrue(first["skip"])
        self.assertEqual(second["keys"], [])
        self.assertFalse((self.dir / "usage-claude.json").exists())

    def test_debug_stops_growing_past_the_cap(self):
        env = dict(self.env, AGENT_FEED_DEBUG="1")
        path = self.dir / statusline.DEBUG_FILE
        path.write_bytes(b"x" * (statusline.DEBUG_MAX_BYTES + 1))
        result = run(payload(), env)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(path.stat().st_size, statusline.DEBUG_MAX_BYTES + 1)
        self.assertTrue((self.dir / "usage-claude.json").exists(), "記録は続ける")

    def test_debug_failure_does_not_break_the_line(self):
        # 書けない（同じ名前のディレクトリがある）ときも、表示と記録はそのまま
        (self.dir / statusline.DEBUG_FILE).mkdir()
        result = run(payload(), dict(self.env, AGENT_FEED_DEBUG="1"))
        self.assertEqual(result.returncode, 0)
        self.assertIn("5時間", result.stdout)
        self.assertTrue((self.dir / "usage-claude.json").exists())

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
        (self.dir / "usage-claude.json").unlink()
        run(payload(rate_limits={"five_hour": {"used_percentage": 90, "resets_at": past}, "seven_day": {"used_percentage": 35, "resets_at": WEEK_RESETS}}), self.env)
        self.assertEqual(self.windows(), {"seven_day": {"used_percentage": 35.0, "resets_at": WEEK_RESETS}})

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

    def test_keeps_the_higher_value_of_the_same_window(self):
        # しばらく API を呼んでいないセッションは、前に受け取った低い値を持ち回る（#689）
        def week(percent, resets=WEEK_RESETS):
            return payload(rate_limits={"seven_day": {"used_percentage": percent, "resets_at": resets}})

        placed = self.record_at(timedelta(minutes=-10), {"seven_day": {"used_percentage": 47.0, "resets_at": WEEK_RESETS}})
        result = run(week(37), self.env)
        self.assertEqual(self.written(), placed, "同じ窓の低い値では置き直さない（ts も進めない）")
        self.assertIn("週 37%", result.stdout, "表示はそのセッションが持っている値のまま")
        run(week(47, WEEK_RESETS + 5), self.env)
        self.assertEqual(self.written(), placed, "同じ値の描画では書き直さない（ts は値が最後に変わった時刻）")

        # 期限切れの窓が残っているだけでは書き直さない（値が変わっていないのに「時点」が進んでしまう）
        expired = {"used_percentage": 80.0, "resets_at": int(time.time()) - 60}
        placed = self.record_at(timedelta(hours=-3), {"five_hour": expired, "seven_day": {"used_percentage": 47.0, "resets_at": WEEK_RESETS}})
        run(week(37), self.env)
        self.assertEqual(self.written(), placed)

        run(week(48), self.env)
        self.assertEqual(self.written()["rate_limits"]["seven_day"]["used_percentage"], 48.0, "高い値は置き直す")
        self.assertNotEqual(self.written()["ts"], placed["ts"])

        run(week(3, WEEK_RESETS + 7 * 86400), self.env)
        self.assertEqual(self.windows()["seven_day"], {"used_percentage": 3.0, "resets_at": WEEK_RESETS + 7 * 86400}, "新しい窓は低くても置き直す")
        run(week(99), self.env)
        self.assertEqual(self.written()["rate_limits"]["seven_day"]["used_percentage"], 3.0, "前の窓の値では置き直さない")

    def test_a_window_unchanged_for_a_day_takes_a_lower_value(self):
        # 枠が途中でリセットされたとき、高い値が窓の終わりまで残らないように（#689）
        low_week = payload(rate_limits={"seven_day": {"used_percentage": 10, "resets_at": WEEK_RESETS}})
        both = {"five_hour": {"used_percentage": 5.0, "resets_at": FIVE_HOUR_RESETS}, "seven_day": {"used_percentage": 90.0, "resets_at": WEEK_RESETS}}
        self.record_at(timedelta(hours=-25), both)
        run(low_week, self.env)
        self.assertEqual(self.windows(), {"five_hour": both["five_hour"], "seven_day": {"used_percentage": 10.0, "resets_at": WEEK_RESETS}}, "来なかった窓は古くても持ち越す")

        # 5 時間の窓が動いていて記録の ts は新しくても、週が 1 日変わっていなければ週の逃げ道は開く
        day_ago = time.time() - 25 * 3600
        self.record_at(timedelta(minutes=-1), {"five_hour": both["five_hour"], "seven_day": dict(both["seven_day"], changed_at=day_ago)})
        run(low_week, self.env)
        self.assertEqual(self.windows()["seven_day"]["used_percentage"], 10.0)
        self.record_at(timedelta(minutes=-1), {"seven_day": dict(both["seven_day"], changed_at=time.time() - 3600)})
        run(low_week, self.env)
        self.assertEqual(self.windows()["seven_day"]["used_percentage"], 90.0, "変わったばかりの窓は低い値で置き直さない")

    def test_merge_windows(self):
        now = 10_000_000.0

        def w(percent, resets=None, changed=now - 60):
            return {"used_percentage": percent, "changed_at": changed, **({"resets_at": resets} if resets is not None else {})}

        def merge(existing, incoming):
            return statusline.merge_windows(existing, incoming, now)

        gap = statusline.SAME_WINDOW_SECONDS
        old = now - statusline.KEEP_SECONDS - 1
        self.assertEqual(merge({"seven_day": w(47, 1000)}, {"seven_day": w(37, 1000 + gap)}), {"seven_day": w(47, 1000)}, "幅の中は同じ窓")
        self.assertEqual(merge({"seven_day": w(47, 1000)}, {"seven_day": w(37, 1000 + gap + 1)}), {"seven_day": w(37, 1000 + gap + 1)}, "幅を超えて先なら新しい窓")
        self.assertEqual(merge({"seven_day": w(47, 1000)}, {"seven_day": w(99, 1000 - gap - 1)}), {"seven_day": w(47, 1000)}, "手前は前の窓")
        self.assertEqual(merge({"seven_day": w(47, 1000)}, {"seven_day": w(48, 1000 - gap)}), {"seven_day": w(48, 1000 - gap)})
        self.assertEqual(merge({"seven_day": w(47, 1000, old)}, {"seven_day": w(37, 1000)}), {"seven_day": w(37, 1000)}, "長く変わっていない窓は低い値でも置き直す")
        self.assertEqual(merge({"seven_day": w(47, 1000, old)}, {"seven_day": w(47, 1000)}), {"seven_day": w(47, 1000, old)}, "同じ値なら変わった時刻を進めない")
        self.assertEqual(merge({"seven_day": w(47, 1000, old)}, {"seven_day": w(99, 1000 - gap - 1)}), {"seven_day": w(47, 1000, old)}, "前の窓の値は古くても取らない")
        self.assertEqual(merge({"five_hour": w(12, 500, old)}, {"seven_day": w(47, 1000)}), {"five_hour": w(12, 500, old), "seven_day": w(47, 1000)}, "来なかった窓は持ち越す")
        self.assertEqual(merge({"five_hour": w(12)}, {"seven_day": w(47, 1000)}), {"seven_day": w(47, 1000)}, "戻る時刻の無い窓は持ち越さない")
        self.assertEqual(merge({"seven_day": w(47)}, {"seven_day": w(37, 1000)}), {"seven_day": w(37, 1000)}, "比べられなければ来たほう")
        self.assertEqual(merge({"seven_day": w(47, 1000)}, {"seven_day": w(37)}), {"seven_day": w(37)}, "比べられなければ来たほう")

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
