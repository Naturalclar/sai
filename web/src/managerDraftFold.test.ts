import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MANAGER_DRAFT_FOLD_CHARS, MANAGER_DRAFT_FOLD_LINES, managerDraftFolds } from './managerDraftFold.ts'

test('managerDraftFolds: 字数か行数のどちらかが超えたら畳む（#565）', () => {
  assert.equal(managerDraftFolds('CI を見て'), false)
  assert.equal(managerDraftFolds('あ'.repeat(MANAGER_DRAFT_FOLD_CHARS)), false)
  assert.equal(managerDraftFolds('あ'.repeat(MANAGER_DRAFT_FOLD_CHARS + 1)), true)
  assert.equal(managerDraftFolds(Array(MANAGER_DRAFT_FOLD_LINES).fill('行').join('\n')), false)
  assert.equal(managerDraftFolds(Array(MANAGER_DRAFT_FOLD_LINES + 1).fill('行').join('\n')), true)
})
