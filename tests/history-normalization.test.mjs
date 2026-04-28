import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const userJs = readFileSync('public/js/user.js', 'utf8');
const adminJs = readFileSync('public/js/admin.js', 'utf8');

test('user history loads the normal mailbox page only', () => {
  assert.doesNotMatch(userJs, /LIST_FETCH_LIMIT|MAX_LIST_FETCH_PAGES/);
  assert.doesNotMatch(userJs, /for \(let page = 0; page < MAX_LIST_FETCH_PAGES/);
  assert.match(userJs, /const response = await mailboxAPI\.getMailboxes\(\);/);
});

test('admin home history loads the normal own mailbox page only', () => {
  assert.doesNotMatch(adminJs, /HISTORY_FETCH_LIMIT|HISTORY_MAX_PAGES/);
  assert.doesNotMatch(adminJs, /for \(let page = 0; page < HISTORY_MAX_PAGES/);
  assert.match(adminJs, /const response = await mailboxAPI\.getMailboxes\(\{ scope: 'own' \}\);/);
});
