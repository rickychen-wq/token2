'use strict';

const assert = require('assert');
const { createAuth, TEST_FEATURES, normalizeTestAccess, hasTestAccess, ADMIN_SEASON_TWO_AVATAR_IDS } = require('./core/auth');
const { testStore } = require('./test_store');

assert.deepStrictEqual(TEST_FEATURES, ['estate', 'tower']);
assert.deepStrictEqual(normalizeTestAccess(['tower', 'bad', 'tower', 'estate']), ['estate', 'tower']);
assert.strictEqual(hasTestAccess({ role: 'admin' }, 'estate'), true);
assert.strictEqual(hasTestAccess({ role: 'player', testAccess: ['tower'] }, 'tower'), true);
assert.strictEqual(hasTestAccess({ role: 'player', testAccess: ['tower'] }, 'estate'), false);

(async () => {
  let clock = 1000;
  const store = testStore({
    'players/27': { pid: '27', name: 'Chen', role: 'admin', claimed: true, testAccess: [], unlocked: { avatars: ADMIN_SEASON_TWO_AVATAR_IDS.slice() } },
    'players/27/private/auth': { hash: 'admin', sv: 1 },
    'players/01': { pid: '01', name: 'Tester', role: 'player', claimed: true, testAccess: [] },
    'players/01/private/auth': { hash: 'tester', sv: 1 }
  });
  const auth = createAuth({
    db: store.db,
    auth: { setCustomUserClaims: async () => {} },
    now: () => clock
  });
  const adminReq = { auth: { uid: 'admin-uid', token: { pid: '27', sv: 1 } }, data: {} };
  const testerReq = { auth: { uid: 'tester-uid', token: { pid: '01', sv: 1 } }, data: {} };

  await assert.rejects(auth.requireTestAccess(testerReq, 'tower'), /測試權限/);
  let result = await auth.adminSetTestAccess(Object.assign({}, adminReq, { data: { pid: '01', feature: 'tower', enabled: true } }));
  assert.deepStrictEqual(result.testAccess, ['tower']);
  assert.deepStrictEqual(store.read('players/01').testAccess, ['tower']);
  assert.strictEqual((await auth.requireTestAccess(testerReq, 'tower')).pid, '01');
  await assert.rejects(auth.requireTestAccess(testerReq, 'estate'), /測試權限/);

  result = await auth.adminSetTestAccess(Object.assign({}, adminReq, { data: { pid: '01', feature: 'estate', enabled: true } }));
  assert.deepStrictEqual(result.testAccess, ['estate', 'tower']);
  result = await auth.adminSetTestAccess(Object.assign({}, adminReq, { data: { pid: '01', feature: 'tower', enabled: false } }));
  assert.deepStrictEqual(result.testAccess, ['estate']);
  await assert.rejects(auth.requireTestAccess(testerReq, 'tower'), /測試權限/);
  assert.strictEqual((await auth.requireTestAccess(adminReq, 'tower')).pid, '27');
  await assert.rejects(auth.adminSetTestAccess(Object.assign({}, adminReq, { data: { pid: '01', feature: 'unknown', enabled: true } })), /未知/);
  console.log('test access tests passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
