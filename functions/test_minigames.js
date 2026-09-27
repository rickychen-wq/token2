'use strict';

const assert = require('assert');
const {
  createMini, gamesCfg, mineCanPlay, mineNextValue, mineSpecialRate, mineCanCashout, MINE_OUTCOMES,
  MINE_REWARDS, mineRewardForRoll, applyMineReward,
  CIPHER_SYMBOLS, cipherCanPlay, cipherCreateCode, cipherCleanGuess, cipherScore, cipherMultiplier, cipherSpecialRate
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

const cipher = gamesCfg({}).cipher;
assert.strictEqual(cipher.enabled, false);
assert.deepStrictEqual(cipher.bets, [200, 500, 1000, 2000, 5000]);
assert.strictEqual(cipherCanPlay(cipher, 'admin'), true);
assert.strictEqual(cipherCanPlay(cipher, 'player'), false);
assert.strictEqual(cipherCanPlay(Object.assign({}, cipher, { enabled: true }), 'player'), true);
assert.deepStrictEqual(cipher.payouts, [3, 2.5, 2, 2, 1.75, 1.25]);
assert.deepStrictEqual(cipherScore(['nova', 'prism', 'orbit', 'flare'], ['nova', 'orbit', 'void', 'prism']), { exact: 1, misplaced: 2 });
assert.deepStrictEqual(cipherScore(['nova', 'prism', 'orbit', 'flare'], ['nova', 'prism', 'orbit', 'flare']), { exact: 4, misplaced: 0 });
assert.strictEqual(cipherMultiplier(1, cipher), 3);
assert.strictEqual(cipherMultiplier(2, cipher), 2.5);
assert.strictEqual(cipherMultiplier(4, cipher), 2);
assert.strictEqual(cipherMultiplier(5, cipher), 1.75);
assert.strictEqual(cipherMultiplier(6, cipher), 1.25);
assert.strictEqual(cipherMultiplier(7, cipher), 0);
assert.strictEqual(cipherSpecialRate(cipher, 1, 5000), 0.5);
assert.strictEqual(cipherSpecialRate(cipher, 2, 5000), 0.3);
assert.strictEqual(cipherSpecialRate(cipher, 3, 5000), 0.2);
assert.strictEqual(cipherSpecialRate(cipher, 4, 5000), 0.1);
assert.strictEqual(cipherSpecialRate(cipher, 5, 5000), 0);
assert.strictEqual(cipherSpecialRate(cipher, 1, 2000), 0);
assert.deepStrictEqual(cipherCleanGuess(['nova', 'prism', 'orbit', 'flare']), ['nova', 'prism', 'orbit', 'flare']);
assert.throws(() => cipherCleanGuess(['nova', 'nova', 'orbit', 'flare']), /不重複/);
assert.throws(() => cipherCleanGuess(['nova', 'prism', 'orbit', 'bad']), /不重複/);
const generated = cipherCreateCode((n) => n - 1);
assert.strictEqual(generated.length, 4);
assert.strictEqual(new Set(generated).size, 4);
assert.strictEqual(generated.every((x) => CIPHER_SYMBOLS.indexOf(x) >= 0), true);
const guardedCipher = gamesCfg({ games: { cipher: { enabled: true, bets: [1], maxAttempts: 99, payouts: [100], specialBet: 1, specialChances: [1, 1, 1, 1, 1, 1] } } }).cipher;
assert.strictEqual(guardedCipher.enabled, true);
assert.deepStrictEqual(guardedCipher.bets, [200, 500, 1000, 2000, 5000]);
assert.strictEqual(guardedCipher.maxAttempts, 6);
assert.deepStrictEqual(guardedCipher.payouts, [3, 2.5, 2, 2, 1.75, 1.25]);
assert.strictEqual(guardedCipher.specialBet, 5000);
assert.deepStrictEqual(guardedCipher.specialChances, [0.5, 0.3, 0.2, 0.1, 0, 0]);

(async function endpointChecks() {
  let role = 'player';
  const account = { wallet: 10000, bank: { balance: 0 }, loans: [] };
  let cipherSecret = null;
  const ref = { collection() { return this; }, doc() { return this; } };
  const tx = {
    get: async () => ({ exists: !!cipherSecret, data: () => cipherSecret }),
    set: (unused, data) => { cipherSecret = data; },
    delete: () => { cipherSecret = null; }
  };
  const api = createMini({
    db: { collection: () => ref },
    now: () => 123456,
    requireSession: async () => ({ pid: '27', player: { role } }),
    requireAdmin: async () => ({}),
    mutate: async (pid, fn, meta) => {
      const ctx = { t: 123456, sid: 'test', pid, cfg: {}, rawCfg: {} };
      const extra = meta && meta.load ? await meta.load(tx, ctx) : null;
      fn(account, {}, 123456, {}, { name: 'chen', tasks: {} }, () => {}, extra);
      if (meta && meta.write) await meta.write(tx, extra, Object.assign({ acc: account }, ctx));
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
  delete account.mine;
  account.wallet = 10000;
  role = 'player';
  await assert.rejects(() => api.cipherStart({ data: { bet: 200 } }), /尚未開放/);
  assert.strictEqual(account.wallet, 10000);
  role = 'admin';
  const cipherStarted = await api.cipherStart({ data: { bet: 1000 } });
  assert.strictEqual(cipherStarted.preview, true);
  assert.strictEqual(cipherStarted.wallet, 9000);
  assert.strictEqual(cipherStarted.session.attempts.length, 0);
  assert.strictEqual(Array.isArray(cipherSecret.code), true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(cipherStarted.session, 'code'), false);
  const rotated = cipherSecret.code.slice(1).concat(cipherSecret.code[0]);
  const cipherMiss = await api.cipherGuess({ data: { guess: rotated } });
  assert.strictEqual(cipherMiss.won, false);
  assert.strictEqual(cipherMiss.ended, false);
  assert.strictEqual(cipherMiss.exact, 0);
  assert.strictEqual(cipherMiss.misplaced, 4);
  assert.strictEqual(cipherMiss.session.attempts.length, 1);
  await assert.rejects(() => api.cipherGuess({ data: { guess: rotated } }), /已經猜過/);
  assert.strictEqual(account.cipher.attempts.length, 1);
  const cipherWon = await api.cipherGuess({ data: { guess: cipherSecret.code.slice() } });
  assert.strictEqual(cipherWon.won, true);
  assert.strictEqual(cipherWon.ended, true);
  assert.strictEqual(cipherWon.attempt, 2);
  assert.strictEqual(cipherWon.payout, 2500);
  assert.strictEqual(cipherWon.specialEligible, false);
  assert.strictEqual(cipherWon.wallet, 11500);
  assert.strictEqual(cipherSecret, null);
  assert.strictEqual(account.cipher, undefined);
  const losingStarted = await api.cipherStart({ data: { bet: 200 } });
  assert.strictEqual(losingStarted.wallet, 11300);
  const losingCode = cipherSecret.code.slice();
  const remaining = CIPHER_SYMBOLS.filter((x) => losingCode.indexOf(x) < 0).slice(0, 4);
  const losingGuesses = [
    losingCode.slice(1).concat(losingCode[0]), losingCode.slice(2).concat(losingCode.slice(0, 2)),
    losingCode.slice(3).concat(losingCode.slice(0, 3)), remaining,
    remaining.slice(1).concat(remaining[0]), remaining.slice(2).concat(remaining.slice(0, 2))
  ];
  let cipherLost;
  for (const guess of losingGuesses) cipherLost = await api.cipherGuess({ data: { guess } });
  assert.strictEqual(cipherLost.won, false);
  assert.strictEqual(cipherLost.ended, true);
  assert.strictEqual(cipherLost.attempt, 6);
  assert.strictEqual(cipherLost.payout, 0);
  assert.deepStrictEqual(cipherLost.answer, losingCode);
  assert.strictEqual(cipherLost.wallet, 11300);
  assert.strictEqual(cipherSecret, null);
  assert.strictEqual(account.cipher, undefined);
  console.log('minigame tests passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
