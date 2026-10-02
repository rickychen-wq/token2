'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { cleanActivity, activeActivity, createActivities } = require('./core/activities');
const { gamesCfg, mineOutcome, mineSpecialRate, createMini, gateOdds } = require('./games/minigames');
const { testStore } = require('./test_store');

const t = 100000;
const gate = cleanActivity({ game: 'gate', payoutMult: 4, durationSec: 30 }, '27', t);
const mine = cleanActivity({ game: 'mine', trapReduction: 50, specialChance: 100, durationSec: 60 }, '27', t);
const raw = { games: { mine: { enabled: true } }, gameActivities: { gate, mine } };
assert.strictEqual(activeActivity(raw, 'gate', t - 1), null);
assert.strictEqual(activeActivity(raw, 'gate', t).id, gate.id);
assert.strictEqual(activeActivity(raw, 'gate', gate.endsAt), null);
assert.strictEqual(gamesCfg(raw, t).gate.payoutMult, 4);
assert.strictEqual(gamesCfg(raw, gate.endsAt).gate.payoutMult, 1);
assert.strictEqual(gamesCfg(raw, mine.endsAt).mine.trapReduction, 0);
assert.strictEqual(gamesCfg(raw, mine.endsAt).mine.safeSpecialChance, 0.05);
assert.strictEqual(gamesCfg(raw, mine.endsAt).mine.treasureSpecialChance, 0.10);
assert.strictEqual(gamesCfg(raw, t).mine.safeMult, 1.25);
assert.strictEqual(gamesCfg(raw, t).mine.treasureMult, 1.55);
assert.strictEqual(mineSpecialRate(gamesCfg(raw, t).mine, 'safe', 5000), 1);
assert.strictEqual(mineSpecialRate(gamesCfg(raw, t).mine, 'safe', 2000), 0);
assert.strictEqual(mineSpecialRate(gamesCfg(raw, t).mine, 'trap', 5000), 0);
for (const reduction of [0, 0.5, 0.7, 0.8, 1]) {
  const counts = { safe: 0, treasure: 0, trap: 0 };
  for (let n = 0; n < 30000; n++) counts[mineOutcome({ trapReduction: reduction }, n / 30000)]++;
  assert.strictEqual(counts.trap, Math.round(10000 * (1 - reduction)));
  assert.ok(Math.abs(counts.safe - counts.treasure) <= 1);
}
for (const patch of [{ durationSec: 0 }, { durationSec: 1.5 }, { payoutMult: 11 }, { payoutMult: '' }, { game: 'poker' }]) {
  assert.throws(() => cleanActivity(Object.assign({ game: 'gate', payoutMult: 2, durationSec: 30 }, patch), '27', t));
}
assert.throws(() => cleanActivity({ game: 'mine', durationSec: 30, trapReduction: 101 }, '27', t));
assert.throws(() => cleanActivity({ game: 'mine', durationSec: 30, trapReduction: 50, specialChance: -1 }, '27', t));

(async () => {
  let role = 'player', clock = t;
  const store = testStore({ 'config/app': { games: { mine: { enabled: false } }, announce: { text: '保留公告' } } });
  const events = createActivities({ db: store.db, now: () => clock, requireAdmin: async () => {
    if (role !== 'admin') throw new Error('只有管理員');
    return { pid: '27' };
  } });
  await assert.rejects(events.start({ data: { game: 'gate', payoutMult: 2, durationSec: 30 } }), /管理員/);
  assert.strictEqual(store.writes(), 0);
  role = 'admin';
  const started = await events.start({ data: { game: 'gate', payoutMult: 3, durationSec: 30 } });
  assert.strictEqual(started.event.endsAt, clock + 30000);
  await events.start({ data: { game: 'mine', trapReduction: 100, specialChance: 100, durationSec: 60 } });
  assert.strictEqual(store.read('config/app').gameActivities.gate.id, started.event.id, '兩個遊戲可同時活動');
  assert.strictEqual(store.read('config/app').games.mine.enabled, false, '活動不會打開未公開的遊戲');
  assert.strictEqual(store.read('config/app').announce.text, '保留公告');
  const replacement = await events.start({ data: { game: 'gate', payoutMult: 4, durationSec: 300 } });
  await assert.rejects(events.stop({ data: { game: 'gate', id: started.event.id } }), /已變更/);
  assert.strictEqual(store.read('config/app').gameActivities.gate.id, replacement.event.id);
  clock += 10000;
  await events.stop({ data: { game: 'gate', id: replacement.event.id } });
  assert.strictEqual(activeActivity(store.read('config/app'), 'gate', clock), null);
  assert.ok(activeActivity(store.read('config/app'), 'mine', clock));

  // 端點派彩而非只驗證公式；固定抽牌，活動結束前後同一手得到不同加成。
  const acc = { wallet: 100000, bank: { balance: 0 }, loans: 0 };
  const player = { stars: 0, items: {} };
  const api = createMini({ db: store.db, now: () => clock,
    requireSession: async () => ({ pid: '27', player: { role: 'admin' } }), requireAdmin: async () => ({ pid: '27' }),
    mutate: async (pid, fn) => { fn(acc, {}, clock, raw, player, () => {}); return { account: acc }; }
  });
  const originalRandomInt = crypto.randomInt;
  try {
    clock = t;
    crypto.randomInt = () => 0;
    for (const [picked, expected] of [[18, 'win'], [0, 'post']]) {
      acc.gate = { version: 2, posts: [0, 48] };
      crypto.randomInt = () => picked;
      const result = await api.gateShoot({ data: { bet: 500 } });
      assert.strictEqual(result.result, expected);
      assert.strictEqual(result.delta, expected === 'win' ? Math.floor(500 * gateOdds(2, 14, null, 0.05).mult * 4) : -1000);
    }
    acc.gate = { version: 2, posts: [12, 32] };
    crypto.randomInt = () => 0;
    const lose = await api.gateShoot({ data: { bet: 500 } });
    assert.strictEqual(lose.result, 'lose'); assert.strictEqual(lose.delta, -500);
    clock = gate.endsAt;
    acc.gate = { version: 2, posts: [0, 48] }; crypto.randomInt = () => 18;
    const expired = await api.gateShoot({ data: { bet: 500 } });
    assert.strictEqual(expired.delta, Math.floor(500 * gateOdds(2, 14, null, 0.05).mult));
    await assert.rejects(api.gateShoot({ data: { bet: 500 } }), /先發門柱/);
    clock = t;
    acc.mine = { active: true, bet: 5000, value: 5000, depth: 1 }; crypto.randomInt = () => 0;
    const reward = await api.mineChoose({ data: { door: 0 } });
    assert.strictEqual(reward.kind, 'safe'); assert.strictEqual(reward.value, 6250);
    assert.strictEqual(reward.specialTriggered, true); assert.strictEqual(reward.specialRate, 1);
    clock = mine.endsAt;
    acc.mine = { active: true, bet: 5000, value: 5000, depth: 1 }; crypto.randomInt = () => 29999;
    const trapped = await api.mineChoose({ data: { door: 2 } });
    assert.strictEqual(trapped.kind, 'trap'); assert.strictEqual(acc.mine, undefined);
  } finally { crypto.randomInt = originalRandomInt; }
  console.log('activity tests passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
