'use strict';

const assert = require('assert');
const { createTower, BETS, PAYOUTS, towerMultiplier, towerLanding } = require('./games/tower');

assert.deepStrictEqual(BETS, [200, 500, 1000, 2000, 5000]);
assert.strictEqual(towerMultiplier(9), 0);
assert.strictEqual(towerMultiplier(10), 1);
assert.strictEqual(towerMultiplier(11), 1.2);
assert.strictEqual(towerMultiplier(12), 1.5);
assert.strictEqual(towerMultiplier(13), 1.7);
assert.strictEqual(towerMultiplier(14), 2);
assert.strictEqual(towerMultiplier(20), 10);
assert.strictEqual(PAYOUTS[15], 2.5);
assert.deepStrictEqual(towerLanding(62, 50, 0.7), { missed: false, width: 62, center: 50, offset: 0.7, perfect: true });
assert.deepStrictEqual(towerLanding(62, 50, 10), { missed: false, width: 52, center: 55, offset: 10, perfect: false });
assert.strictEqual(towerLanding(20, 50, -20).missed, true);
assert.throws(() => towerLanding(62, 50, 101), /落板位置/);

(async () => {
  let role = 'player', clock = 1000;
  const account = { wallet: 10000, bank: { balance: 0 }, loans: [] };
  const api = createTower({
    now: () => clock,
    requireAdmin: async () => {
      if (role !== 'admin') throw new Error('只有管理員');
      return { pid: '27', player: { role: 'admin' } };
    },
    mutate: async (pid, fn) => {
      fn(account, {}, clock, {}, { name: 'Chen', tasks: {} }, () => {});
      return { account };
    }
  });
  await assert.rejects(api.state({ data: {} }), /只有管理員/);
  role = 'admin';
  let r = await api.start({ data: { bet: 1000 } });
  assert.strictEqual(r.wallet, 9000);
  assert.strictEqual(r.run.layer, 0);
  await assert.rejects(api.start({ data: { bet: 200 } }), /正在建造/);
  for (let layer = 1; layer <= 10; layer++) {
    clock += 1000;
    r = await api.drop({ data: { layer, offset: layer === 1 ? 5 : 0.5 } });
  }
  assert.strictEqual(r.run.layer, 10);
  assert.strictEqual(r.run.multiplier, 1);
  await assert.rejects(api.drop({ data: { layer: 10, offset: 0 } }), /處理過/);
  r = await api.cashout({ data: {} });
  assert.strictEqual(r.payout, 1000);
  assert.strictEqual(r.profit, 0);
  assert.strictEqual(r.wallet, 10000);
  await api.start({ data: { bet: 500 } });
  r = await api.drop({ data: { layer: 1, offset: 62 } });
  assert.strictEqual(r.missed, true);
  assert.strictEqual(r.payout, 0);
  assert.strictEqual(r.wallet, 9500);
  await api.start({ data: { bet: 200 } });
  r = await api.abandon({ data: {} });
  assert.strictEqual(r.abandoned, true);
  assert.strictEqual(r.wallet, 9300);
  console.log('tower tests passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
