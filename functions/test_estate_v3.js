'use strict';

const assert = require('assert');
const {
  createEstate, seedCity, seedProfile, normalizeCity, publicState,
  baseRate, rateAt, storageCap, upgradeSpec, maxHoldings, ATTACK_DEBUFF_MS
} = require('./core/estate_v3');
const { testStore } = require('./test_store');

const t = Date.parse('2026-10-04T04:00:00Z');
const admin = { pid: '27', name: 'Chen' };
const seeded = seedCity(t, admin);
const b2 = seeded.plots.find((p) => p.id === 'B2');
const a1 = seeded.plots.find((p) => p.id === 'A1');

assert.strictEqual(seeded.version, 3);
assert.strictEqual(seeded.plots.length, 16);
assert.strictEqual(b2.stage, 1);
assert.strictEqual(b2.level, 0);
assert.deepStrictEqual(upgradeSpec(b2).materials, { wood: 2, stone: 3 });
assert.strictEqual(upgradeSpec(b2).money, 50000);
assert.strictEqual(baseRate({ stage: 3, level: 3 }), 650);
assert.strictEqual(rateAt({ stage: 3, level: 3, debuffUntil: t + 1 }, t), 299);
assert.strictEqual(storageCap({ stage: 1, level: 0 }), 1800);
assert.strictEqual(publicState(seeded, '27', t, seedProfile('27', t)).maxHoldings, 1);
assert.strictEqual(maxHoldings(seeded, '27'), 1);
const finished = normalizeCity(seeded, t, admin);
Object.assign(finished.plots.find((p) => p.id === 'B2'), { stage: 5, level: 10 });
assert.strictEqual(maxHoldings(finished, '27'), 2);

(async () => {
  let role = 'player', clock = t;
  const profile = seedProfile('27', t);
  a1.storedCash = 10000;
  a1.mines = 1;
  const store = testStore({
    'estateSandbox/city01': seeded,
    'estateSandbox/city01/profiles/27': profile
  });
  const wallet = { value: 1000000 };
  const fakeMutate = async (pid, fn, meta) => store.db.runTransaction(async (tx) => {
    const extra = await meta.load(tx, { t: clock, sid: 'test', pid, cfg: {}, rawCfg: {} });
    const acc = { wallet: wallet.value };
    const entries = fn(acc, {}, clock, {}, {}, () => {}, extra) || [];
    await meta.write(tx, extra, { t: clock, sid: 'test', pid, cfg: {}, rawCfg: {}, acc });
    wallet.value = acc.wallet;
    return { sid: 'test', account: acc, extra, entries };
  });
  const estate = createEstate({
    db: store.db, now: () => clock, mutate: fakeMutate,
    requireAdmin: async () => {
      if (role !== 'admin') throw new Error('只有管理員');
      return admin;
    }
  });

  await assert.rejects(estate.state({ data: {} }), /管理員/);
  role = 'admin';
  let result = await estate.state({ data: {} });
  assert.strictEqual(result.state.version, 3);
  assert.strictEqual(result.state.holdings, 1);
  assert.strictEqual(result.state.profile.missiles, 8);
  await assert.rejects(estate.action({ data: { action: 'claim', lotId: 'B1' } }), /五階十級/);

  clock += 10 * 60000;
  result = await estate.state({ data: {} });
  assert.strictEqual(result.state.plots.find((p) => p.id === 'B2').storedCash, 600);
  result = await estate.economy({ data: { action: 'collect', lotId: 'B2' } });
  assert.strictEqual(result.amount, 600);
  assert.strictEqual(result.state.plots.find((p) => p.id === 'B2').storedCash, 0);
  assert.strictEqual(wallet.value, 1000600);

  result = await estate.economy({ data: { action: 'upgrade', lotId: 'B2' } });
  assert.strictEqual(result.stage, 1);
  assert.strictEqual(result.level, 1);
  assert.strictEqual(wallet.value, 950600);
  assert.strictEqual(result.state.profile.materials.wood, 118);
  assert.strictEqual(result.state.profile.materials.stone, 117);

  result = await estate.action({ data: { action: 'mine', lotId: 'B2' } });
  assert.strictEqual(result.state.plots.find((p) => p.id === 'B2').mines, 1);
  assert.strictEqual(result.state.profile.mines, 1);
  await assert.rejects(estate.action({ data: { action: 'attack', lotId: 'B2', weapon: 'missile' } }), /自己的/);
  await assert.rejects(estate.action({ data: { action: 'attack', lotId: 'A1', weapon: 'bomb' } }), /只開放重型飛彈/);

  result = await estate.action({ data: { action: 'attack', lotId: 'A1', weapon: 'missile' } });
  assert.strictEqual(result.defended, true);
  assert.strictEqual(result.state.plots.find((p) => p.id === 'A1').storedCash, 10000);
  assert.strictEqual(result.state.profile.missiles, 7);
  result = await estate.action({ data: { action: 'attack', lotId: 'A1', weapon: 'missile' } });
  const hit = result.state.plots.find((p) => p.id === 'A1');
  assert.strictEqual(result.defended, false);
  assert.strictEqual(hit.storedCash, 2500);
  assert.strictEqual(hit.materialPausedCycles, 3);
  assert.strictEqual(hit.debuffUntil, clock + ATTACK_DEBUFF_MS);
  assert.strictEqual(result.state.profile.missiles, 6);

  result = await estate.action({ data: { action: 'reset' } });
  assert.strictEqual(result.state.profile.missiles, 8);
  assert.strictEqual(result.state.plots.find((p) => p.id === 'B2').level, 0);
  console.log('estate v3 tests passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });

