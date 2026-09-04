import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeProfile, PROFILE_ICON_ID, profileIconUrl } from './profile.ts'

test('mergeProfile は名前だけ見て、セッションの表示名と同じ検査をする', () => {
  assert.deepEqual(mergeProfile({}, { name: '  Jesse  ' }), { name: 'Jesse', error: '' })
  assert.deepEqual(mergeProfile({ name: 'Jesse' }, {}), { name: 'Jesse', error: '' }, '省略は据え置き')
  assert.deepEqual(mergeProfile({ name: 'Jesse' }, { name: '' }), { name: undefined, error: '' }, '空は消す')
  assert.deepEqual(mergeProfile({ name: 'Jesse' }, { name: null }), { name: undefined, error: '' })
  assert.notEqual(mergeProfile({}, { name: 'x'.repeat(101) }).error, '')
  assert.notEqual(mergeProfile({}, { name: 5 }).error, '')
  assert.notEqual(mergeProfile({}, 'x').error, '')
  // archived_at のような他のキーは無視する（アーカイブの口ではない）
  assert.deepEqual(mergeProfile({}, { name: 'a', archived_at: 'now' }), { name: 'a', error: '' })
})

test('PROFILE_ICON_ID はエンティティ ID と衝突しない形、URL は v 付き', () => {
  assert.equal(PROFILE_ICON_ID.includes('@'), false)
  assert.equal(profileIconUrl('123.4'), '/api/profile/icon?v=123.4')
})
