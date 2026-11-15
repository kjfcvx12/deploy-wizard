import test from 'node:test'
import assert from 'node:assert/strict'
import { notificationRoute, readSettingValues, unreadLabel } from '../../features/notifications/ui/logic.js'
import {
  NOTIFICATION_KINDS, NOTIFICATION_KIND_LABEL, NOTIFICATION_KIND_ICON, NOTIFICATION_KIND_BADGE, KIND_HINT,
  PUSH_HINT_WEB, UNREAD_CHANGED_EVENT,
} from '../../features/notifications/ui/constants.js'

const SERVER_KINDS = ['incident_opened', 'incident_recovered', 'incident_needs_action', 'deploy_succeeded', 'deploy_failed', 'new_commit']

test('constants cover every server kind in server order', () => {
  assert.deepEqual(NOTIFICATION_KINDS, SERVER_KINDS)
  for (const kind of SERVER_KINDS) {
    assert.ok(NOTIFICATION_KIND_LABEL[kind], kind)
    assert.ok(NOTIFICATION_KIND_ICON[kind], kind)
    assert.ok(NOTIFICATION_KIND_BADGE[kind], kind)
    assert.ok(KIND_HINT[kind], kind)
  }
  assert.deepEqual(NOTIFICATION_KIND_BADGE, {
    incident_opened: 'exp', incident_recovered: 'ok', incident_needs_action: 'err',
    deploy_succeeded: 'ok', deploy_failed: 'err', new_commit: 'run',
  })
  assert.equal(UNREAD_CHANGED_EVENT, 'dw:unread-changed')
  assert.ok(PUSH_HINT_WEB.startsWith('푸시는 앱에서'))
})

test('notificationRoute: valid ids per kind', () => {
  for (const kind of ['incident_opened', 'incident_recovered', 'incident_needs_action']) {
    assert.equal(notificationRoute({ kind, i_id: 7, d_id: 2 }), '/incidents/7')
  }
  for (const kind of ['deploy_succeeded', 'deploy_failed', 'new_commit']) {
    assert.equal(notificationRoute({ kind, i_id: 7, d_id: 2 }), '/deploys/2')
  }
  assert.equal(notificationRoute({ kind: 'incident_opened', i_id: 2147483647 }), '/incidents/2147483647')
})

test('notificationRoute: bad ids give null', () => {
  for (const bad of [null, undefined, 0, -1, '1abc', 2147483648, 1.5, '007', '', {}, NaN]) {
    assert.equal(notificationRoute({ kind: 'deploy_failed', d_id: bad }), null, String(bad))
    assert.equal(notificationRoute({ kind: 'incident_opened', i_id: bad }), null, String(bad))
  }
  assert.equal(notificationRoute(null), null)
  assert.equal(notificationRoute(undefined), null)
})

test('notificationRoute: unknown kind follows the deploy rule', () => {
  assert.equal(notificationRoute({ kind: 'something_new', d_id: 4, i_id: 9 }), '/deploys/4')
  assert.equal(notificationRoute({ kind: 'something_new', d_id: null, i_id: 9 }), null)
})

test('readSettingValues', () => {
  assert.deepEqual(readSettingValues(undefined), { notify_email: false, notify_push: false, kinds: [] })
  assert.deepEqual(readSettingValues(null), { notify_email: false, notify_push: false, kinds: [] })
  assert.deepEqual(readSettingValues('x'), { notify_email: false, notify_push: false, kinds: [] })
  assert.deepEqual(readSettingValues({ notify_email: true }), { notify_email: true, notify_push: false, kinds: [] })
  assert.deepEqual(readSettingValues({ notify_email: 'true', notify_push: 1, kinds: 'new_commit' }),
    { notify_email: false, notify_push: false, kinds: [] })
  assert.deepEqual(
    readSettingValues({ notify_email: true, notify_push: true, kinds: ['new_commit', 'bogus', 'incident_opened'] }),
    { notify_email: true, notify_push: true, kinds: ['incident_opened', 'new_commit'] })
})

test('unreadLabel', () => {
  assert.equal(unreadLabel(0), '')
  assert.equal(unreadLabel(-3), '')
  assert.equal(unreadLabel(1), '1')
  assert.equal(unreadLabel(99), '99')
  assert.equal(unreadLabel(100), '99+')
  assert.equal(unreadLabel(undefined), '')
  assert.equal(unreadLabel('3'), '')
  assert.equal(unreadLabel(NaN), '')
})
