'use strict';

const assert = require('assert');
const { createEstate, seedCity, publicState } = require('./core/estate');
const { testStore } = require('./test_store');

const t = Date.parse('2026-10-03T04:00:00Z');
const admin = { pid: '27', name: 'Chen' };
const seed = seedCity(t, admin);
assert.strictEqual(seed.plots.length, 16);
assert.strictEqual(new Set(seed.plots.map((p) => p.id)).size, 16);
assert.deepStrictEqual(seed.plots.filter((p) => p.status === 'showcase').map((p) => p.stage), [2, 3, 4, 5]);
assert.strictEqual(publicState(seed, '27', t).holdings, 1);

(async () => {
  let role = 'player', clock = t;
  const store = testStore({});
  const estate = createEstate({ db: store.db, now: () => clock, requireAdmin: async () => {
    if (role !== 'admin') throw new Error('只有管理員');
    return admin;
  } });
  await assert.rejects(estate.state({ data: {} }), /管理員/);
  assert.strictEqual(store.writes(), 0);
  role = 'admin';
  let result = await estate.state({ data: {} });
  assert.strictEqual(result.state.plots.length, 16);
  assert.strictEqual(result.state.holdings, 1);
  result = await estate.action({ data: { action: 'buy', lotId: 'B1' } });
  assert.strictEqual(result.state.holdings, 2);
  assert.strictEqual(result.state.plots.find((p) => p.id === 'B1').stage, 1);
  assert.ok(result.state.plots.find((p) => p.id === 'B1').shielded);
  await assert.rejects(estate.action({ data: { action: 'buy', lotId: 'B3' } }), /最多持有/);
  result = await estate.action({ data: { action: 'stage', lotId: 'B1', stage: 5 } });
  assert.strictEqual(result.state.plots.find((p) => p.id === 'B1').stage, 5);
  result = await estate.action({ data: { action: 'mine', lotId: 'B1' } });
  assert.strictEqual(result.state.plots.find((p) => p.id === 'B1').mines, 1);
  await assert.rejects(estate.action({ data: { action: 'attack', lotId: 'B1', weapon: 'missile' } }), /自己的/);
  result = await estate.action({ data: { action: 'attack', lotId: 'A1', weapon: 'missile' } });
  assert.strictEqual(result.damage, 35); assert.strictEqual(result.state.plots.find((p) => p.id === 'A1').integrity, 65);
  result = await estate.action({ data: { action: 'attack', lotId: 'A1', weapon: 'bomb' } });
  assert.strictEqual(result.state.plots.find((p) => p.id === 'A1').integrity, 15);
  result = await estate.action({ data: { action: 'attack', lotId: 'A1', weapon: 'missile' } });
  assert.strictEqual(result.ruined, true); assert.strictEqual(result.state.plots.find((p) => p.id === 'A1').status, 'ruined');
  result = await estate.action({ data: { action: 'foreclose', lotId: 'A1' } });
  assert.strictEqual(result.state.plots.find((p) => p.id === 'A1').status, 'vacant');
  result = await estate.action({ data: { action: 'sell', lotId: 'B1' } });
  assert.strictEqual(result.state.holdings, 1);
  result = await estate.action({ data: { action: 'reset' } });
  assert.strictEqual(result.state.holdings, 1); assert.strictEqual(result.state.vacant, 11);
  assert.ok(store.writes() > 0);
  console.log('estate tests passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
