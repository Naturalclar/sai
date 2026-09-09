import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectFromRemote, projectName, rowProject } from './project.ts'

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

test('rowProject: project → remote から補う → repo（worktree 名）の順', () => {
  assert.equal(rowProject({ project: 'Naturalclar/sai', remote: 'https://github.com/x/y', repo: 'dev-min' }), 'Naturalclar/sai')
  assert.equal(rowProject({ project: '', remote: 'https://github.com/Naturalclar/sai', repo: 'dev-min' }), 'Naturalclar/sai', '古い行は remote から')
  assert.equal(rowProject({ repo: 'dev-min' }), 'dev-min', 'remote も無ければ worktree 名のまま')
  assert.equal(rowProject({ project: '   ', remote: '', repo: 'kanban' }), 'kanban')
  assert.equal(rowProject({ repo: '' }), '')
})

test('projectName: 表示用の短い名前', () => {
  assert.equal(projectName('Naturalclar/sai'), 'sai')
  assert.equal(projectName('sai'), 'sai')
  assert.equal(projectName(''), '')
})
