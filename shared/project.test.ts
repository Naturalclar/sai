import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRemote, projectFromCommonDir, projectFromRemote, projectName, rowProject } from './project.ts'

test('projectFromRemote: 正規化済みの remote から owner/repo。読めなければ空', () => {
  assert.equal(projectFromRemote('https://github.com/Naturalclar/sai'), 'Naturalclar/sai')
  assert.equal(projectFromRemote('https://github.com/Naturalclar/kanban'), 'Naturalclar/kanban')
  // GitLab のサブグループは最後の2つ
  assert.equal(projectFromRemote('https://gitlab.example.com/grp/sub/repo'), 'sub/repo')
  assert.equal(projectFromRemote('https://github.com/Naturalclar/sai/'), 'Naturalclar/sai')
  assert.equal(projectFromRemote(''), '')
  assert.equal(projectFromRemote(undefined), '')
  assert.equal(projectFromRemote('https://github.com/onlyowner'), '', 'owner だけでは分からない')
})

test('rowProject: project → remote の順。分からなければ空（worktree 名には落とさない。#182）', () => {
  assert.equal(rowProject({ project: 'Naturalclar/sai', remote: 'https://github.com/x/y' }), 'Naturalclar/sai')
  assert.equal(rowProject({ project: '', remote: 'https://github.com/Naturalclar/sai' }), 'Naturalclar/sai', '古い行は remote から')
  assert.equal(rowProject({}), '', 'どちらも無ければ空。サーバが cwd から埋める')
  assert.equal(rowProject({ project: '   ', remote: '' }), '')
})

test('normalizeRemote: record.py の normalize_remote と同じ答え', () => {
  for (const [raw, want] of [
    ['https://github.com/acme/kanban.git', 'https://github.com/acme/kanban'],
    ['https://github.com/acme/kanban', 'https://github.com/acme/kanban'],
    ['git@github.com:acme/kanban.git', 'https://github.com/acme/kanban'],
    ['ssh://git@github.com/acme/kanban.git', 'https://github.com/acme/kanban'],
    ['ssh://git@gitlab.example.com:2222/grp/sub/repo.git', 'https://gitlab.example.com/grp/sub/repo'],
    ['https://user:token@github.com/acme/kanban.git', 'https://github.com/acme/kanban'],
    ['/Users/me/repos/local', ''],
    ['file:///Users/me/repos/local', ''],
    ['', ''],
    ['   ', ''],
  ] as const) {
    assert.equal(normalizeRemote(raw), want, raw)
  }
  assert.equal(normalizeRemote(undefined), '')
})

test('projectFromCommonDir: bare も普通の clone も同じ答え', () => {
  // bare clone の worktree
  assert.equal(projectFromCommonDir('/h/sai.git/dev-min', '/h/sai.git'), 'sai')
  // 普通の clone（toplevel から / サブディレクトリから。cwd からの相対で来る）
  assert.equal(projectFromCommonDir('/h/sai', '.git'), 'sai')
  assert.equal(projectFromCommonDir('/h/sai/a/b', '../../.git'), 'sai')
  // 普通の clone に足した worktree（絶対パスで元の .git を指す）
  assert.equal(projectFromCommonDir('/h/sai-wt', '/h/sai/.git'), 'sai')
  // bare の名前が .git で終わらないこともある
  assert.equal(projectFromCommonDir('/h/bare/wt', '/h/bare'), 'bare')
  assert.equal(projectFromCommonDir('/h/x', ''), '')
})

test('projectName: 表示用の短い名前', () => {
  assert.equal(projectName('Naturalclar/sai'), 'sai')
  assert.equal(projectName('sai'), 'sai')
  assert.equal(projectName(''), '')
})
