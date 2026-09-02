#!/usr/bin/env python3
"""SAI: agent-feed の JSONL をローカルで眺めるための最小 HTTP サーバ。

127.0.0.1 にしか bind しない。デプロイもホスティングもしない。
集計（セッション単位へのまとめ）はここでやる。ブラウザに生の JSONL を
全部投げて JS でまとめると、日が経つほど重くなるため。

  python3 web/serve.py            # http://127.0.0.1:8787/
  python3 web/serve.py --port 9000 --feed-dir ~/.agent-feed

エンドポイント:
  GET /                                  ビューア（web/dist/。`pnpm build` の成果物）
  GET /api/sessions?days=7&repo=&agent=&date=
  GET /api/sessions/<id>?days=30
  GET /api/feed?days=3
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
DIST = HERE / "dist"  # `pnpm build` の成果物
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
}
NO_DIST = (
    "<!doctype html><meta charset=utf-8><title>SAI</title>"
    "<body style='font-family:sans-serif;padding:2em'>"
    "<h1>SAI</h1><p><code>web/dist/</code> がありません。先にビルドしてください:</p>"
    "<pre>cd web &amp;&amp; pnpm install &amp;&amp; pnpm build</pre>"
    "<p>開発中は <code>pnpm dev</code> で Vite を立てると、このサーバの API に流れます。</p>"
)

TITLE_LEN = 60
TITLE_FULL_LEN = 300
MAX_DAYS = 366

_JST = timezone(timedelta(hours=9), "JST")


def tz() -> timezone:
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo("Asia/Tokyo")  # type: ignore[return-value]
    except Exception:
        return _JST


# ---------------------------------------------------------------- 読み込み（キャッシュ付き）

class FeedStore:
    """日付ファイルを (mtime, size) で覚えて、変わっていなければ再パースしない。"""

    def __init__(self, directory: Path):
        self.directory = directory
        self._files: dict[Path, tuple[float, int, list[dict]]] = {}
        self._sessions: dict[tuple, tuple[str, list[dict]]] = {}
        self._lock = threading.Lock()

    # -- ファイル単位

    def _read_file(self, path: Path) -> list[dict]:
        try:
            stat = path.stat()
        except OSError:
            self._files.pop(path, None)
            return []
        key = (stat.st_mtime, stat.st_size)
        cached = self._files.get(path)
        if cached and cached[0] == key[0] and cached[1] == key[1]:
            return cached[2]
        rows: list[dict] = []
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    if isinstance(obj, dict) and obj.get("ts"):
                        rows.append(obj)
        except OSError:
            rows = []
        self._files[path] = (key[0], key[1], rows)
        return rows

    def _paths(self, days: int) -> list[Path]:
        today = datetime.now(tz()).date()
        return [self.directory / f"{(today - timedelta(days=offset)).isoformat()}.jsonl" for offset in range(days)]

    def signature(self, days: int) -> tuple:
        parts = []
        for path in self._paths(days):
            try:
                stat = path.stat()
                parts.append((path.name, stat.st_mtime, stat.st_size))
            except OSError:
                continue
        return tuple(parts)

    def rows(self, days: int) -> list[dict]:
        with self._lock:
            rows: list[dict] = []
            for path in self._paths(days):
                rows.extend(self._read_file(path))
        rows.sort(key=lambda row: str(row.get("ts", "")))
        return rows

    # -- セッション単位

    def sessions(self, days: int) -> tuple[str, list[dict]]:
        signature = self.signature(days)
        key = (days, signature)
        with self._lock:
            cached = self._sessions.get(key)
        if cached:
            return cached
        rows = self.rows(days)
        result = (_rev(signature), aggregate(rows))
        with self._lock:
            # 古い窓のキャッシュは捨てる。days ごとに最新の1つだけ残す
            for stale in [k for k in self._sessions if k[0] == days]:
                del self._sessions[stale]
            self._sessions[key] = result
        return result


def _rev(signature: tuple) -> str:
    return hashlib.sha1(repr(signature).encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------- 集計

def first_line(text: str) -> str:
    for line in (text or "").splitlines():
        line = line.strip()
        if line:
            return line
    return ""


def clip(text: str, size: int) -> str:
    return text if len(text) <= size else text[: size - 1] + "…"


def _local_date(ts: str) -> str:
    try:
        return datetime.fromisoformat(ts).astimezone(tz()).date().isoformat()
    except Exception:
        return str(ts)[:10]


def aggregate(rows: list[dict]) -> list[dict]:
    """行をセッション単位にまとめる。入力は ts 昇順であること。"""
    groups: dict[str, list[dict]] = {}
    for row in rows:
        session = row.get("session")
        if not isinstance(session, str) or not session:
            session = f"unknown-{row.get('repo', '')}-{_local_date(str(row.get('ts', '')))}"
        groups.setdefault(session, []).append(row)

    sessions = []
    for session_id, items in groups.items():
        first, last = items[0], items[-1]
        repos = _ordered_unique(str(r.get("repo") or "") for r in items)
        branches = _ordered_unique(str(r.get("branch") or "") for r in items)
        agents = _ordered_unique(str(r.get("agent") or "unknown") for r in items)
        sources = _ordered_unique(str(r.get("session_source") or "") for r in items)
        title_full = ""
        for row in items:
            value = row.get("first_user_text")
            if isinstance(value, str) and value.strip():
                title_full = first_line(value)
                break
        if not title_full:
            title_full = first_line(str(first.get("text") or ""))
        sessions.append(
            {
                "id": session_id,
                "start": first.get("ts"),
                "end": last.get("ts"),
                "date": _local_date(str(first.get("ts"))),
                "dates": _ordered_unique(_local_date(str(r.get("ts"))) for r in items),
                "agent": agents[-1],
                "agents": agents,
                "repo": repos[-1] if repos else "",
                "repos": [r for r in repos if r],
                "branch": branches[-1] if branches else "",
                "branches": [b for b in branches if b],
                "cwd": last.get("cwd", ""),
                "turns": len(items),
                "title": clip(title_full, TITLE_LEN),
                "title_full": clip(title_full, TITLE_FULL_LEN),
                "session_source": "synth" if "synth" in sources else (sources[-1] if sources else ""),
                "sources": sources,
                "last_text": clip(first_line(str(last.get("text") or "")), 120),
            }
        )
    sessions.sort(key=lambda s: str(s.get("end") or ""), reverse=True)
    return sessions


def _ordered_unique(values) -> list[str]:
    seen: list[str] = []
    for value in values:
        if value not in seen:
            seen.append(value)
    return seen


def filter_sessions(sessions: list[dict], repo: str, agent: str, date: str) -> list[dict]:
    result = sessions
    if repo:
        result = [s for s in result if repo in s["repos"]]
    if agent:
        result = [s for s in result if agent in s["agents"]]
    if date:
        result = [s for s in result if date in s["dates"]]
    return result


def facets(sessions: list[dict]) -> dict:
    repos = sorted({r for s in sessions for r in s["repos"]})
    agents = sorted({a for s in sessions for a in s["agents"]})
    dates = sorted({d for s in sessions for d in s["dates"]}, reverse=True)
    return {"repos": repos, "agents": agents, "dates": dates}


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    store: FeedStore  # set by serve()
    server_version = "sai/0.1"

    def log_message(self, fmt, *args):  # 静かにする
        if os.environ.get("SAI_VERBOSE"):
            super().log_message(fmt, *args)

    def do_GET(self):
        url = urlsplit(self.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        path = url.path
        try:
            if path == "/" or path == "/index.html":
                return self._send_static("index.html")
            if path.startswith("/assets/"):
                return self._send_static(path.lstrip("/"))
            if path == "/api/sessions":
                return self._api_sessions(query)
            if path.startswith("/api/sessions/"):
                return self._api_session(path[len("/api/sessions/"):], query)
            if path == "/api/feed":
                return self._api_feed(query)
            if path == "/api/health":
                return self._json({"ok": True})
            if path == "/favicon.ico":
                return self._respond(204, b"", "image/x-icon")
            return self._error(404, "not found")
        except Exception as exc:  # 表示側が壊れても記録側には影響しない
            return self._error(500, f"{type(exc).__name__}: {exc}")

    # -- ルート

    def _send_static(self, relative: str):
        """dist/ の中だけを配る。外に出る path は 404"""
        root = DIST.resolve()
        target = (root / relative).resolve()
        if root not in target.parents and target != root:
            return self._error(404, "not found")
        if not target.is_file():
            if relative == "index.html":
                return self._respond(200, NO_DIST.encode("utf-8"), "text/html; charset=utf-8")
            return self._error(404, "not found")
        try:
            body = target.read_bytes()
        except OSError:
            return self._error(500, "read failed")
        self._respond(200, body, MIME.get(target.suffix, "application/octet-stream"))

    def _api_sessions(self, query: dict):
        days = _days(query.get("days"), 7)
        rev, sessions = self.store.sessions(days)
        filtered = filter_sessions(
            sessions, query.get("repo", ""), query.get("agent", ""), query.get("date", "")
        )
        return self._json(
            {
                "rev": rev,
                "days": days,
                "total": len(sessions),
                "sessions": filtered,
                "filters": facets(sessions),
            }
        )

    def _api_session(self, session_id: str, query: dict):
        session_id = session_id.strip("/")
        if not session_id or "/" in session_id:
            return self._error(400, "bad session id")
        days = _days(query.get("days"), 30)
        rev, sessions = self.store.sessions(days)
        match = next((s for s in sessions if s["id"] == session_id), None)
        if match is None:
            return self._error(404, "session not found in window")
        rows = [r for r in self.store.rows(days) if r.get("session") == session_id]
        return self._json({"rev": rev, "session": match, "rows": rows})

    def _api_feed(self, query: dict):
        days = _days(query.get("days"), 3)
        rows = self.store.rows(days)
        repo = query.get("repo", "")
        if repo:
            rows = [r for r in rows if r.get("repo") == repo]
        return self._json({"rev": _rev(self.store.signature(days)), "days": days, "rows": rows})

    # -- 出力

    def _json(self, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._respond(200, body, "application/json; charset=utf-8")

    def _error(self, status: int, message: str):
        body = json.dumps({"error": message}).encode("utf-8")
        self._respond(status, body, "application/json; charset=utf-8")

    def _respond(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def _days(raw, default: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, min(MAX_DAYS, value))


def serve(host: str, port: int, directory: Path) -> None:
    if host not in ("127.0.0.1", "localhost", "::1"):
        # 中身は作業内容そのものなので外に出さない
        print(f"refusing to bind to {host}: SAI is local-only", file=sys.stderr)
        sys.exit(2)
    Handler.store = FeedStore(directory)
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    print(f"SAI  http://{host}:{port}/   feed={directory}", file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description="SAI local viewer")
    parser.add_argument("--port", type=int, default=int(os.environ.get("SAI_PORT", "8787")))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--feed-dir",
        default=os.environ.get("AGENT_FEED_DIR") or str(Path.home() / ".agent-feed"),
    )
    args = parser.parse_args(argv)
    serve(args.host, args.port, Path(args.feed_dir).expanduser())


if __name__ == "__main__":
    main()
