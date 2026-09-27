'use strict';

const assert = require('assert');
const {
  createMini, gamesCfg, mineCanPlay, mineNextValue, mineSpecialRate, mineCanCashout, MINE_OUTCOMES,
  MINE_REWARDS, mineRewardForRoll, applyMineReward
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

assert.strictEqual(mineNextValue(200, 'safe', base), 250);
assert.strictEqual(mineNextValue(200, 'treasure', base), 310);
assert.strictEqual(mineNextValue(288, 'safe', base), 360);
assert.strictEqual(mineNextValue(5000, 'trap', base), 0);

assert.strictEqual(mineSpecialRate(base, 'safe', 2000), 0);
assert.strictEqual(mineSpecialRate(base, 'safe', 5000), 0.05);
assert.strictEqual(mineSpecialRate(base, 'treasure', 5000), 0.10);
assert.strictEqual(mineSpecialRate(base, 'trap', 5000), 0);
assert.deepStrictEqual(MINE_REWARDS.map((x) => x.until), [3000, 5000, 6000, 7000, 8000, 8500, 9000, 9500, 9750, 10000]);
assert.deepStrictEqual(MINE_REWARDS.map((x, i, a) => (x.until - (i ? a[i - 1].until : 0)) / 100), [30, 20, 10, 10, 10, 5, 5, 5, 2.5, 2.5]);
assert.deepStrictEqual(mineRewardForRoll(0), { kind: 'money', amount: 3000, name: '遊戲幣 3,000' });
assert.strictEqual(mineRewardForRoll(2999).amount, 3000);
assert.strictEqual(mineRewardForRoll(3000).amount, 5000);
assert.strictEqual(mineRewardForRoll(4999).amount, 5000);
assert.strictEqual(mineRewardForRoll(5000).itemId, 'chest_3');
assert.strictEqual(mineRewardForRoll(7999).itemId, 'chest_5');
assert.strictEqual(mineRewardForRoll(8000).itemId, 'key_5');
assert.strictEqual(mineRewardForRoll(8999).itemId, 'key_4');
assert.strictEqual(mineRewardForRoll(9000).kind, 'stars');
assert.strictEqual(mineRewardForRoll(9499).amount, 30);
assert.strictEqual(mineRewardForRoll(9500).itemId, 'chest_6');
assert.strictEqual(mineRewardForRoll(9750).itemId, 'key_6');
assert.strictEqual(mineRewardForRoll(9999).itemId, 'key_6');
assert.strictEqual(mineRewardForRoll(10000), null);
const rewardAcc = { wallet: 100, bank: { balance: 0 }, loans: [] }, rewardPlayer = {};
assert.strictEqual(applyMineReward(rewardAcc, rewardPlayer, mineRewardForRoll(0)).ledger[0].amount, 3000);
assert.strictEqual(rewardAcc.wallet, 3100);
assert.strictEqual(applyMineReward(rewardAcc, rewardPlayer, mineRewardForRoll(9000)).player.stars, 30);
assert.strictEqual(applyMineReward(rewardAcc, rewardPlayer, mineRewardForRoll(5000)).player.items.chest_3, 1);

const guarded = gamesCfg({ games: { mine: {
  enabled: true, bets: [1], safeMult: 99, treasureMult: 99,
  specialMinBet: 0, safeSpecialChance: 1, treasureSpecialChance: 1
} } }).mine;
assert.strictEqual(guarded.enabled, true);
assert.deepStrictEqual(guarded.bets, [200, 500, 1000, 2000, 5000]);
assert.strictEqual(guarded.safeMult, 1.25);
assert.strictEqual(guarded.treasureMult, 1.55);
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
