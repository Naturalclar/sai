#!/usr/bin/env python3
"""serve.py のテスト。集計とエンドポイントを実際に 127.0.0.1 で立てて叩く。"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parent))
import serve  # noqa: E402

JST = timezone(timedelta(hours=9))


def row(ts, session, agent="claude", repo="kanban", branch="main", text="hi", first_user="", source="payload"):
    return {
        "ts": ts.isoformat(timespec="seconds"), "agent": agent, "repo": repo, "branch": branch,
        "session": session, "session_source": source, "cwd": f"/home/u/{repo}",
        "event": "Stop", "text": text, "first_user_text": first_user,
    }


class AggregateTest(unittest.TestCase):
    def test_groups_by_session_newest_first(self):
        base = datetime(2026, 9, 2, 10, 0, tzinfo=JST)
        rows = [
            row(base, "A", text="第一声\n二行目", first_user="やりたいこと"),
            row(base + timedelta(minutes=5), "A", branch="feat", text="second"),
            row(base + timedelta(minutes=9), "A", repo="other", text="third"),
            row(base + timedelta(hours=1), "B", agent="codex", text="codex says", source="synth"),
        ]
        sessions = serve.aggregate(rows)
        self.assertEqual([s["id"] for s in sessions], ["B", "A"])
        a = sessions[1]
        self.assertEqual(a["turns"], 3)
        self.assertEqual(a["title"], "やりたいこと")
        self.assertEqual(a["repo"], "other")
        self.assertEqual(a["repos"], ["kanban", "other"])
        self.assertEqual(a["branch"], "feat")
        self.assertEqual(a["branches"], ["main", "feat"])
        self.assertEqual(a["session_source"], "payload")
        self.assertEqual(a["date"], "2026-09-02")
        b = sessions[0]
        self.assertEqual(b["title"], "codex says", "first_user_text が無ければ最初の text の1行目")
        self.assertEqual(b["session_source"], "synth")

    def test_title_is_clipped_to_60(self):
        base = datetime(2026, 9, 2, 10, 0, tzinfo=JST)
        sessions = serve.aggregate([row(base, "A", first_user="あ" * 100)])
        self.assertEqual(len(sessions[0]["title"]), 60)
        self.assertTrue(sessions[0]["title"].endswith("…"))

    def test_filters(self):
        base = datetime(2026, 9, 2, 10, 0, tzinfo=JST)
        sessions = serve.aggregate([
            row(base, "A", repo="x"), row(base, "B", repo="y", agent="codex"),
            row(base - timedelta(days=1), "C", repo="x"),
        ])
        self.assertEqual({s["id"] for s in serve.filter_sessions(sessions, "x", "", "")}, {"A", "C"})
        self.assertEqual({s["id"] for s in serve.filter_sessions(sessions, "", "codex", "")}, {"B"})
        self.assertEqual({s["id"] for s in serve.filter_sessions(sessions, "x", "", "2026-09-01")}, {"C"})
        self.assertEqual(serve.facets(sessions)["dates"], ["2026-09-02", "2026-09-01"])


class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.feed_dir = Path(cls.tmp.name)
        now = datetime.now(JST)
        cls.today = now.strftime("%Y-%m-%d")
        with (cls.feed_dir / f"{cls.today}.jsonl").open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(row(now - timedelta(minutes=10), "S1", first_user="題名")) + "\n")
            handle.write("this line is broken\n")
            handle.write(json.dumps(row(now - timedelta(minutes=5), "S1", text="two")) + "\n")
            handle.write(json.dumps(row(now - timedelta(minutes=1), "S2", agent="codex", repo="sai")) + "\n")
        serve.Handler.store = serve.FeedStore(cls.feed_dir)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def get(self, path):
        with urlopen(f"http://127.0.0.1:{self.port}{path}") as res:
            return res.status, res.headers.get("Content-Type", ""), res.read()

    def test_viewer(self):
        status, ctype, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ctype)
        self.assertIn(b"SAI", body)

    def test_sessions(self):
        status, _, body = self.get("/api/sessions?days=7")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual([s["id"] for s in data["sessions"]], ["S2", "S1"])
        self.assertEqual(data["filters"]["repos"], ["kanban", "sai"])
        self.assertEqual(data["filters"]["agents"], ["claude", "codex"])
        self.assertEqual(data["sessions"][1]["turns"], 2)
        self.assertEqual(data["sessions"][1]["title"], "題名")
        self.assertIn("rev", data)

    def test_sessions_filtered(self):
        _, _, body = self.get("/api/sessions?days=7&agent=codex")
        data = json.loads(body)
        self.assertEqual([s["id"] for s in data["sessions"]], ["S2"])
        self.assertEqual(data["total"], 2, "filters は絞り込み前の全体から作る")

    def test_session_detail(self):
        status, _, body = self.get("/api/sessions/S1")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(data["session"]["id"], "S1")
        self.assertEqual([r["text"] for r in data["rows"]], ["hi", "two"])

    def test_session_missing(self):
        with self.assertRaises(HTTPError) as ctx:
            self.get("/api/sessions/nope")
        self.assertEqual(ctx.exception.code, 404)

    def test_feed(self):
        _, _, body = self.get("/api/feed?days=3")
        data = json.loads(body)
        self.assertEqual(len(data["rows"]), 3, "壊れた行は落とす")

    def test_refuses_non_local_host(self):
        with self.assertRaises(SystemExit):
            serve.serve("0.0.0.0", 0, self.feed_dir)


class CacheTest(unittest.TestCase):
    def test_cache_invalidates_on_append(self):
        with tempfile.TemporaryDirectory() as tmp:
            feed_dir = Path(tmp)
            now = datetime.now(JST)
            path = feed_dir / f"{now.strftime('%Y-%m-%d')}.jsonl"
            path.write_text(json.dumps(row(now - timedelta(minutes=3), "S1")) + "\n", encoding="utf-8")
            store = serve.FeedStore(feed_dir)
            rev1, sessions1 = store.sessions(7)
            self.assertEqual(len(sessions1), 1)
            # 変わっていなければ同じオブジェクトが返る（再パースしない）
            rev2, sessions2 = store.sessions(7)
            self.assertEqual(rev1, rev2)
            self.assertIs(sessions1, sessions2)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row(now, "S2")) + "\n")
            rev3, sessions3 = store.sessions(7)
            self.assertNotEqual(rev1, rev3)
            self.assertEqual(len(sessions3), 2)


if __name__ == "__main__":
    unittest.main()
