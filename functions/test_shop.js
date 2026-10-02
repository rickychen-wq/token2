'use strict';

const assert = require('assert');
const C = require('./core/catalog');
const S = require('./core/shop');

function player(backs) {
  return { stars: 0, items: {}, unlocked: { backs: (backs || []).slice() } };
}

function rolls(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

const cat = { items: C.merge(null) };

assert.deepStrictEqual(S.CARD_BACK_BONUS_RATE, { 4: 0.02, 5: 0.05, 6: 0.15 });
assert.strictEqual(S.rollCardBackBonus(3, cat, player(), () => 0), null, '史詩寶箱沒有牌背加抽');
assert.strictEqual(S.rollCardBackBonus(7, cat, player(), () => 0), null, '管理員寶箱沒有未指定的牌背加抽');

[
  { rarity: 4, hit: 0.019999, miss: 0.02 },
  { rarity: 5, hit: 0.049999, miss: 0.05 },
  { rarity: 6, hit: 0.149999, miss: 0.15 }
].forEach((row) => {
  const won = player();
  const result = S.rollCardBackBonus(row.rarity, cat, won, rolls([row.hit, 0]));
  assert.strictEqual(result.hit, true);
  assert.ok(result.item && result.item.type === 'back');
  assert.strictEqual(won.unlocked.backs.length, 1);
  assert.strictEqual(won.unlocked.backs[0], result.item.itemId);

  const lost = player();
  const miss = S.rollCardBackBonus(row.rarity, cat, lost, () => row.miss);
  assert.deepStrictEqual(miss, { chance: S.CARD_BACK_BONUS_RATE[row.rarity], hit: false, completed: false, item: null });
  assert.deepStrictEqual(lost.unlocked.backs, []);
});

const allBacks = Object.keys(cat.items).filter((id) => cat.items[id].type === 'back');
const almost = player(allBacks.slice(0, -1));
const last = S.rollCardBackBonus(6, cat, almost, rolls([0, 0.999]));
assert.strictEqual(last.item.itemId, allBacks[allBacks.length - 1], '中獎時優先補玩家沒有的牌背');
assert.strictEqual(almost.unlocked.backs.length, allBacks.length);

const full = player(allBacks);
const complete = S.rollCardBackBonus(6, cat, full, () => 0);
assert.strictEqual(complete.hit, true);
assert.strictEqual(complete.completed, true);
assert.strictEqual(complete.item, null);
assert.deepStrictEqual(full.unlocked.backs, allBacks);

const E = require('./core/econ');
const { seasonId } = require('./core/util');
const { testStore } = require('./test_store');
const urId = Object.keys(cat.items).find((id) => cat.items[id].sub === 'ur');
const backId = allBacks[0];
const choices = { chest: 7, key: 7, urChoice: urId, backChoice: backId };
const legacy = C.merge({ items: { chest_7: { loot: { stars: { min: 150, max: 150 }, items: cat.items.chest_7.loot.items, avatar: 1, ur: 0, bg: 1, dex: 1 } } } });
assert.deepStrictEqual(legacy.chest_7.loot.stars, { min: 2000, max: 2000 });
assert.strictEqual(legacy.chest_7.loot.money, 1000000);
assert.strictEqual(legacy.chest_7.loot.ur, 1);
assert.deepStrictEqual(legacy.chest_7.loot.items, cat.items.chest_7.loot.items);
assert.throws(() => S.adminChestChoices(cat, { urChoice: backId, backChoice: backId }), /UR/);
assert.throws(() => S.adminChestChoices(cat, { urChoice: urId, backChoice: urId }), /牌背/);
assert.throws(() => S.adminChestChoices({ items: { ...cat.items, [urId]: { ...cat.items[urId], hidden: true } } }, choices), /UR/);

(async () => {
  const t = Date.parse('2026-10-02T04:00:00Z'), sid = seasonId(t), accPath = 'seasons/' + sid + '/accounts/02';
  const cfg = E.cfgOf(null), initialAccount = E.newAccount('02', cfg, t);
  initialAccount.wallet = 5000;
  const fixture = (extra) => testStore(Object.assign({
    'players/02': { pid: '02', role: 'player', stars: 0, items: { chest_7: 1, key_7: 1 }, unlocked: {} },
    'config/app': {}, ['seasons/' + sid]: { status: 'active' }, [accPath]: initialAccount
  }, extra));
  const api = (store) => S.createShop({ db: store.db, now: () => t,
    requireSession: async () => ({ pid: '02' }), requireAdmin: async () => { throw new Error('not-admin'); }
  });
  const store = fixture(), shop = api(store);
  await assert.rejects(shop.openChest({ data: { chest: 7, key: 7 } }), /UR/);
  await assert.rejects(shop.openChest({ data: { ...choices, backChoice: 'not-a-back' } }), /牌背/);
  assert.strictEqual(store.writes(), 0, '選擇不完整不扣寶箱與鑰匙');
  const result = await shop.openChest({ data: choices });
  const p = store.read('players/02'), a = store.read(accPath);
  assert.strictEqual(result.stars, 2000); assert.strictEqual(result.money, 1000000);
  assert.strictEqual(p.stars, 2000); assert.strictEqual(a.wallet, 1005000);
  assert.strictEqual(a.net, 1005000); assert.strictEqual(p.stats.peakNet, 1005000);
  assert.strictEqual(p.items.chest_7, 0); assert.strictEqual(p.items.key_7, 0);
  assert.ok(p.unlocked.avatars.includes(urId)); assert.ok(p.unlocked.backs.includes(backId));
  assert.strictEqual(p.items.bankruptcy_protection, 20); assert.strictEqual(p.items.forced_duel, 10);
  assert.strictEqual(p.items.forced_action, 10); assert.strictEqual(p.items.premium_dry_shampoo, 10);
  assert.strictEqual(p.items.iron_bowl, 35); assert.strictEqual(p.items.broken_bowl, 0);
  assert.strictEqual(result.fused, 25); assert.strictEqual(result.backBonus, null);
  assert.strictEqual(p.unlocked.bgs.length, 1); assert.strictEqual(p.unlocked.dex.length, 1);
  assert.strictEqual(result.items.filter((x) => x.tag === 'ur').length, 1);
  assert.ok(Object.values(store.all()).some((x) => x.type === 'chest' && x.amount === 1000000));
  await assert.rejects(shop.openChest({ data: choices }), /沒有.*寶箱/);
  assert.strictEqual(store.read(accPath).wallet, 1005000, '不能重複領獎');

  const locked = fixture({ ['seasons/' + sid]: { status: 'locked' } });
  await assert.rejects(api(locked).openChest({ data: choices }), /結算/);
  assert.strictEqual(locked.writes(), 0); assert.strictEqual(locked.read('players/02').items.chest_7, 1);
  const concurrent = fixture();
  const attempts = await Promise.allSettled([api(concurrent).openChest({ data: choices }), api(concurrent).openChest({ data: choices })]);
  assert.strictEqual(attempts.filter((x) => x.status === 'fulfilled').length, 1);
  assert.strictEqual(concurrent.read(accPath).wallet, 1005000);
  const fresh = testStore({ 'players/02': { stars: 0, items: { chest_7: 1, key_7: 1 } } });
  await api(fresh).openChest({ data: choices });
  assert.strictEqual(fresh.read('seasons/' + sid).status, 'active');
  assert.strictEqual(fresh.read(accPath).wallet, cfg.startingMoney + 1000000);
  const debtAccount = { ...initialAccount, loans: 2 };
  const debt = fixture({ [accPath]: debtAccount });
  await api(debt).openChest({ data: choices });
  assert.strictEqual(debt.read(accPath).loans, 0);
  assert.strictEqual(debt.read(accPath).wallet, 1005000 - 2 * cfg.loanUnit);
  const ordinary = testStore({ 'players/02': { stars: 0, items: { chest_1: 1, key_1: 1 } } });
  const normal = await api(ordinary).openChest({ data: { ...choices, chest: 1, key: 1, money: 1000000 } });
  assert.strictEqual(normal.money, 0); assert.strictEqual(ordinary.read(accPath), undefined);
  assert.ok(!ordinary.read('players/02').unlocked.backs.includes(backId), '一般寶箱不能偽造自選與遊戲幣');
  console.log('shop tests passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
