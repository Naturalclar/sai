"""feed/digest_stats.py（#446）。手元のファイルだけを読んで、開いた割合・受け取り率を出す。"""
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from feed import digest_stats


def digest(key, ts, summary="一言", next_ask="", model="qwen3:8b", persona="ESFP"):
    row = {"key": key, "ts": ts, "summary": summary, "model": model, "persona": persona}
    if next_ask:
        row["next_ask"] = next_ask
    return row


def fb(key, reason, ts):
    return {"key": key, "reason": reason, "ts": ts, "summary": "", "model": "", "persona": ""}


class DigestStatsTest(unittest.TestCase):
    def setUp(self):
        self.digests = [
            digest("old|1", "2026-09-01T00:00:00.000Z"),
            digest("a|1", "2026-10-02T00:00:00.000Z", next_ask="直して"),
            digest("b|1", "2026-10-02T01:00:00.000Z", next_ask="続けて", model="haiku", persona="INTJ"),
            # 作り直した行は後ろが正
            digest("c|1", "2026-10-02T02:00:00.000Z", summary="古い一言"),
            digest("c|1", "2026-10-02T02:00:05.000Z", summary="新しい一言"),
            # 案だけ作った行（一言は空）
            digest("d|1", "2026-10-02T03:00:00.000Z", summary="", next_ask="マージして"),
        ]
        self.feedback = [
            fb("a|1", "meaning", "2026-09-20T00:00:00.000Z"),
            fb("a|1", "opened", "2026-10-01T12:00:00.000Z"),
            fb("a|1", "opened", "2026-10-02T12:00:00.000Z"),
            fb("a|1", "next_ask_accepted", "2026-10-02T12:01:00.000Z"),
            fb("d|1", "next_ask_accepted", "2026-10-02T12:02:00.000Z"),
            fb("gone|1", "opened", "2026-10-02T12:03:00.000Z"),
        ]

    def test_rates_count_only_digests_made_after_counting_began(self):
        stats = digest_stats.collect(self.digests, self.feedback)
        self.assertEqual(stats["total"], {"summaries": 3, "opened": 1, "next_asks": 3, "accepted": 2, "asking": 0})
        self.assertEqual(stats["by_model"]["haiku"], {"summaries": 1, "opened": 0, "next_asks": 1, "accepted": 0, "asking": 0})
        self.assertEqual(stats["by_persona"]["ESFP"], {"summaries": 2, "opened": 1, "next_asks": 2, "accepted": 2, "asking": 0})
        self.assertEqual(stats["complaints"], {"meaning": 1})

    def test_replies_left_as_full_text_are_counted_apart_from_summaries(self):
        # 人に聞いている返答は一言を作らない（#638）。一言の数にも「開いた」の分母にも入れず、別に数える
        skipped = dict(digest("e|1", "2026-10-02T04:00:00.000Z", summary=""), skipped="asking")
        stats = digest_stats.collect(self.digests + [skipped], self.feedback)
        self.assertEqual(stats["total"]["asking"], 1)
        self.assertEqual(stats["total"]["summaries"], 3)
        self.assertIn("一言にしなかった: 1 本", digest_stats.render(stats))

    def test_model_verdicts_are_matched_against_the_opened_signal(self):
        # 手元のモデルの判定（#639）。全文が要る＝一言にしなかった。足りると答えたのに開いた＝拾えなかった
        full = dict(digest("f|1", "2026-10-02T04:00:00.000Z", summary=""), skipped="judged", judge="full")
        kept = dict(digest("g|1", "2026-10-02T04:00:00.000Z"), judge="summary")
        missed = dict(digest("h|1", "2026-10-02T04:00:00.000Z"), judge="summary")
        stats = digest_stats.collect(self.digests + [full, kept, missed], self.feedback + [fb("h|1", "opened", "2026-10-02T12:04:00.000Z")])
        self.assertEqual(stats["judge"], {"full": 1, "summary": 2, "summary_opened": 1})
        self.assertEqual(stats["total"]["asking"], 0, "規則が当てた分とは別に数える")
        self.assertIn("全文が要る 1 本", digest_stats.render(stats))
        self.assertIn("要約で足りる 2 本、うち詳細を開いた 1 本", digest_stats.render(stats))
        # 聞いていないときは行を出さない
        self.assertNotIn("手元のモデルの判定", digest_stats.render(digest_stats.collect(self.digests, self.feedback)))

    def test_an_older_digest_that_got_a_signal_is_counted(self):
        # 数え始める前に作った一言でも、開いたなら画面に出ていたということ
        stats = digest_stats.collect(self.digests, self.feedback + [fb("old|1", "opened", "2026-10-03T00:00:00.000Z")])
        self.assertEqual(stats["total"]["summaries"], 4)
        self.assertEqual(stats["total"]["opened"], 2)

    def test_all_includes_digests_made_before_counting_began(self):
        stats = digest_stats.collect(self.digests, self.feedback, include_all=True)
        self.assertEqual(stats["total"]["summaries"], 4)
        self.assertEqual(stats["total"]["opened"], 1)

    def test_no_usage_yet_says_so_and_still_counts_what_was_made(self):
        stats = digest_stats.collect(self.digests, [f for f in self.feedback if f["reason"] == "meaning"])
        self.assertFalse(stats["counting"])
        self.assertEqual(stats["total"]["summaries"], 4)
        self.assertIn("まだ合図", digest_stats.render(stats))

    def test_main_reads_the_given_directory_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "digest.jsonl").write_text("".join(json.dumps(d, ensure_ascii=False) + "\n" for d in self.digests) + "こわれた行\n", encoding="utf-8")
            (directory / "digest-feedback.jsonl").write_text("".join(json.dumps(f) + "\n" for f in self.feedback), encoding="utf-8")
            before = sorted(p.name for p in directory.iterdir())
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(digest_stats.main(["--feed-dir", tmp]), 0)
            self.assertIn("詳細を開いた     1 ( 33%)", out.getvalue())
            self.assertIn("受け取った     2 ( 67%)", out.getvalue())
            self.assertEqual(sorted(p.name for p in directory.iterdir()), before)

    def test_missing_files_are_an_empty_report_not_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(digest_stats.main(["--feed-dir", tmp]), 0)
            self.assertIn("一言     0", out.getvalue())


if __name__ == "__main__":
    unittest.main()
