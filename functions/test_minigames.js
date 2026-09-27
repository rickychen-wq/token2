'use strict';

const assert = require('assert');
const {
  createMini, gamesCfg, mineCanPlay, mineNextValue, mineSpecialRate, mineCanCashout, MINE_OUTCOMES
} = require('./games/minigames');

const base = gamesCfg({}).mine;
assert.strictEqual(base.enabled, false);
assert.deepStrictEqual(base.bets, [200, 500, 1000, 2000, 5000]);
assert.strictEqual(mineCanPlay(base, 'admin'), true);
assert.strictEqual(mineCanPlay(base, 'player'), false);
assert.strictEqual(mineCanPlay(Object.assign({}, base, { enabled: true }), 'player'), true);
assert.deepStrictEqual(MINE_OUTCOMES, ['safe', 'treasure', 'trap']);
assert.strictEqual(mineCanCashout({ active: true, depth: 1 }), false);
assert.strictEqual(mineCanCashout({ active: true, depth: 2 }), true);

assert.strictEqual(mineNextValue(200, 'safe', base), 240);
assert.strictEqual(mineNextValue(200, 'treasure', base), 300);
assert.strictEqual(mineNextValue(288, 'safe', base), 345);
assert.strictEqual(mineNextValue(5000, 'trap', base), 0);

assert.strictEqual(mineSpecialRate(base, 'safe', 2000), 0);
assert.strictEqual(mineSpecialRate(base, 'safe', 5000), 0.05);
assert.strictEqual(mineSpecialRate(base, 'treasure', 5000), 0.10);
assert.strictEqual(mineSpecialRate(base, 'trap', 5000), 0);

const guarded = gamesCfg({ games: { mine: {
  enabled: true, bets: [1], safeMult: 99, treasureMult: 99,
  specialMinBet: 0, safeSpecialChance: 1, treasureSpecialChance: 1
} } }).mine;
assert.strictEqual(guarded.enabled, true);
assert.deepStrictEqual(guarded.bets, [200, 500, 1000, 2000, 5000]);
assert.strictEqual(guarded.safeMult, 1.2);
assert.strictEqual(guarded.treasureMult, 1.5);
assert.strictEqual(guarded.specialMinBet, 2000);
assert.strictEqual(guarded.safeSpecialChance, 0.05);
assert.strictEqual(guarded.treasureSpecialChance, 0.10);

(async function endpointChecks() {
  let role = 'player';
  const account = { wallet: 10000, bank: { balance: 0 }, loans: [] };
  const api = createMini({
    db: {},
    now: () => 123456,
    requireSession: async () => ({ pid: '27', player: { role } }),
    requireAdmin: async () => ({}),
    mutate: async (pid, fn) => {
      fn(account, {}, 123456, {}, { name: 'chen', tasks: {} }, () => {});
      return { account };
    }
  });
  await assert.rejects(() => api.mineStart({ data: { bet: 200 } }), /尚未開放/);
  assert.strictEqual(account.wallet, 10000);
  role = 'admin';
  const started = await api.mineStart({ data: { bet: 5000 } });
  assert.strictEqual(started.preview, true);
  assert.strictEqual(started.wallet, 5000);
  assert.strictEqual(started.session.depth, 1);
  await assert.rejects(() => api.mineStart({ data: { bet: 200 } }), /尚未結束/);
  await assert.rejects(() => api.mineCashout({ data: {} }), /至少成功打開一扇門/);
  assert.strictEqual(account.wallet, 5000);
  console.log('minigame tests passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
