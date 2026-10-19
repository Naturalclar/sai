#!/usr/bin/env python3
"""/setup-sai の点検（読むだけ。#688 で SKILL.md の本文から出した）。

  doctor.py last        一番新しい記録の行（ts / agent / v / repo）
  doctor.py hooks       ~/.claude/settings.json と ./.claude/settings.json の、record.py に届くフック
  doctor.py usage       ~/.agent-feed/usage-claude*.json（Claude の使用率）が新しいか
  doctor.py statusline  ~/.claude/settings.json の statusLine が statusline.py に届くか
  doctor.py images      全体の指示に画像の置き場の 1 行があるか・ほかのリポジトリが .screenshots/ を無視しているか（#820）

何も書かない。標準ライブラリのみ。判定はサーバと同じ規則（server/local/usage.ts の isClaudeUsageFile、
shared/usage.ts の STATUS_MAX_AGE_MS）に合わせる。
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

FEED = os.environ.get('AGENT_FEED_DIR') or os.path.expanduser('~/.agent-feed')
USER_SETTINGS = os.path.expanduser('~/.claude/settings.json')


def reaches(cmd, needle):
    """コマンドが needle（record.py / statusline.py）に届くか。PATH のラッパーは中身を読む"""
    if not cmd:
        return None
    if needle in cmd:
        return cmd
    exe = (cmd.split() or [''])[0]
    p = shutil.which(exe)
    if not p:
        return None
    try:
        body = open(p, encoding='utf-8', errors='replace').read()
    except Exception:
        return None
    return f'{p} 経由' if needle in body else None


def last():
    # 日付のファイルだけを見る。*.jsonl だと digest.jsonl（一言。行の形が違う）を拾って
    # agent も v も None になり、動いているのに「壊れている」と読み違える
    files = sorted(glob.glob(os.path.join(FEED, '20??-??-??*.jsonl')), key=os.path.getmtime)
    if not files:
        print(f'{FEED}: 日付の記録が無い')
        return
    try:
        with open(files[-1], 'rb') as f:
            f.seek(max(0, os.path.getsize(files[-1]) - 262144))
            r = json.loads(f.read().decode('utf-8', 'replace').strip().split('\n')[-1])
    except Exception as e:
        print(f'{files[-1]}: 最後の行が読めない ({e})')
        return
    print(r.get('ts'), r.get('agent'), 'v=%s' % r.get('v'), r.get('repo'))


def hooks():
    for label, path in [('user', USER_SETTINGS), ('project', '.claude/settings.json')]:
        try:
            found = (json.load(open(path)) or {}).get('hooks') or {}
        except Exception:
            print(f'{label}: {path} は無い / 読めない')
            continue
        hits = [(e, g.get('matcher', ''), h.get('command', ''), reaches(h.get('command', ''), 'record.py'))
                for e, gs in found.items() for g in gs for h in g.get('hooks', []) if reaches(h.get('command', ''), 'record.py')]
        print(f'{label}: {path} → record.py に届くフック {len(hits)} 件')
        for e, m, c, v in hits:
            print(f'   {e:18} matcher={m!r} {c!r} -> {v}')


def usage():
    max_age = 8 * 86400  # shared/usage.ts の STATUS_MAX_AGE_MS。これより古いとサーバが捨てる
    try:
        names = sorted(n for n in os.listdir(FEED) if re.fullmatch(r'usage-claude(\.[^/]+)?\.json', n))
    except OSError:
        names = []
    if not names:
        print(f'{FEED}: usage-claude*.json が無い → statusLine 未設定か、まだ 1 回も描画されていない')
    now = time.time()
    for n in names:
        try:
            d = json.load(open(os.path.join(FEED, n)))
        except Exception as e:
            print(f'{n}: 読めない ({e})')
            continue
        age = now - (time.mktime(time.strptime(d.get('ts', '')[:19], '%Y-%m-%dT%H:%M:%S')) if d.get('ts') else 0)
        limits = d.get('rate_limits') or {}
        windows = {k: v.get('used_percentage') for k, v in limits.items() if isinstance(v, dict)}
        print(f'{n}: ts={d.get("ts")} ({age / 3600:.1f}h 前{"、古すぎる" if age > max_age else ""}) windows={windows or "空（subscription でない？）"}')


def statusline():
    try:
        sl = (json.load(open(USER_SETTINGS)) or {}).get('statusLine')
    except Exception as e:
        print(f'{USER_SETTINGS} は無い / 読めない ({e})')
        return
    if not sl:
        print('statusLine: 未設定 → SAI の割合は永久に出ない')
        return
    cmd = sl.get('command', '') if isinstance(sl, dict) else str(sl)
    print(f'statusLine: {cmd!r}')
    print('  statusline.py に届くか:', reaches(cmd, 'statusline.py') or '届かない → 別のものに取られている')


# 画像の置き場の 1 行（#820）。SAI が配るのは作業ディレクトリの中の画像だけなので、ほかのリポジトリで動くエージェントにも
# 「.screenshots/ に置いて ![名前](パス) と書く」を伝える。見るのは利用者の全体の指示だけで、書くのは人が「足して」と言ったとき
IMAGE_LINE = re.compile(r'\.screenshots|SAI[^\n]*画像|画像[^\n]*SAI')


def global_instructions():
    codex_home = os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex')
    return [('codex', os.path.join(codex_home, 'AGENTS.md')), ('claude', os.path.expanduser('~/.claude/CLAUDE.md'))]


def git(args, cwd):
    try:
        r = subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, timeout=5)
    except Exception:
        return None
    return r


def recent_cwds(days=7):
    # 日付はファイル名から見る（<host> 付きのファイルもあるので、ファイルの数で切ると日数が縮む）
    since = time.strftime('%Y-%m-%d', time.localtime(time.time() - (days - 1) * 86400))
    files = [p for p in glob.glob(os.path.join(FEED, '20??-??-??*.jsonl')) if os.path.basename(p)[:10] >= since]
    seen = set()
    for path in files:
        try:
            with open(path, encoding='utf-8', errors='replace') as f:
                for line in f:
                    m = re.search(r'"cwd":\s*"((?:[^"\\]|\\.)*)"', line)
                    if m:
                        try:
                            seen.add(json.loads('"%s"' % m.group(1)))
                        except ValueError:
                            continue  # 書きかけの行
        except OSError:
            continue
    return seen


def images():
    for agent, path in global_instructions():
        try:
            body = open(path, encoding='utf-8', errors='replace').read()
        except OSError:
            print(f'{agent}: {path} は無い → 画像の置き場の 1 行を案として出す')
            continue
        print(f'{agent}: {path} → ' + ('画像の置き場の 1 行がある' if IMAGE_LINE.search(body) else '画像の置き場の 1 行が無い → 案として出す'))
    here = git(['rev-parse', '--git-common-dir'], '.')
    here = os.path.realpath(here.stdout.strip()) if here and here.returncode == 0 else ''
    tops = {}  # 共通の git ディレクトリ → 見せる toplevel（同じリポジトリの worktree は 1 つに数える）
    for cwd in recent_cwds():
        if not os.path.isdir(cwd):
            continue
        top = git(['rev-parse', '--show-toplevel', '--git-common-dir'], cwd)
        if not top or top.returncode != 0:
            continue
        lines = top.stdout.strip().split('\n')
        common = os.path.realpath(os.path.join(cwd, lines[1])) if len(lines) > 1 else ''
        if common and common == here:
            continue  # SAI 自身（.gitignore 済み）
        tops.setdefault(common or lines[0], lines[0])
    missing = []
    for top in sorted(tops.values()):
        r = git(['check-ignore', '-q', '.screenshots/probe.png'], top)
        if r is not None and r.returncode == 1:
            missing.append(top)
    print(f'直近 7 日に記録のあるほかのリポジトリ {len(tops)} 個のうち、.screenshots/ を無視していない {len(missing)} 個（案として出すだけ）')
    for top in missing:
        print(f'   {top}')


COMMANDS = {'last': last, 'hooks': hooks, 'usage': usage, 'statusline': statusline, 'images': images}

if __name__ == '__main__':
    name = sys.argv[1] if len(sys.argv) > 1 else ''
    if name not in COMMANDS:
        print('usage: doctor.py ' + ' | '.join(COMMANDS), file=sys.stderr)
        sys.exit(2)
    COMMANDS[name]()
