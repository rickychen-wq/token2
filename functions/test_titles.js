'use strict';
const assert = require('assert');
const { LAUNCH_AT, TITLES, automaticUnlocks, completedCategories, benefitsOf, dayOf } = require('./core/titles');

function player(overrides) {
  return Object.assign({
    role: 'player', createdAt: LAUNCH_AT - 1,
    unlocked: { titles: [], dex: [] }, equipped: { dex: [] },
    tasks: { career: {}, special: {} }, stats: {}, games: { poker: {} }, titleState: {}
  }, overrides || {});
}

assert.strictEqual(LAUNCH_AT, Date.UTC(2026, 8, 27, 16, 0, 0));
assert.strictEqual(TITLES.length, 31);

const rich = player({
  tasks: { career: { loginDays: 30, plays: 100, dailyDone: 100 }, special: {} },
  stats: { peakNet: 5000000 }
});
const richUnlocked = automaticUnlocks(rich, LAUNCH_AT + 12 * 3600000);
['A01', 'A02', 'A03', 'A04', 'A05', 'B01', 'B02', 'B03', 'B04', 'L01', 'L03'].forEach((id) => assert(richUnlocked.includes(id), id));
assert(!richUnlocked.includes('B05'));

const allA = TITLES.filter((x) => x.category === 'A').map((x) => x.id);
assert(completedCategories(allA).includes('A'));
assert(!completedCategories(TITLES.filter((x) => x.category === 'H' && x.id !== 'H03').map((x) => x.id)).includes('H'));

const at = LAUNCH_AT + 86400000;
const p = player({
  unlocked: { titles: allA.concat(['B04']), dex: [] },
  titleState: { daily: { day: dayOf(at), activeId: 'B04' } }
});
const b = benefitsOf(p, at);
assert.strictEqual(b.taskBonus, 0.10);
assert.strictEqual(b.shopDiscount, 0.03);
assert.deepStrictEqual(benefitsOf(p, LAUNCH_AT - 1), { dailyCash: 0, dailyStars: 0, taskBonus: 0, shopDiscount: 0, interestBonus: 0 });
assert.strictEqual(benefitsOf(p, at + 86400000).shopDiscount, 0);

console.log('titles tests ok');
