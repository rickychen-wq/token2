'use strict';
const assert = require('assert');
const {
  LAUNCH_AT, TITLES, BY_ID, automaticUnlocks, publicTitle,
  recordTitleProgress, progressMap, completedCategories, benefitsOf, dayOf,
  TITLE_RESET_VERSION, clearTitles, unlockAdminCollections
} = require('./core/titles');

function player(overrides) {
  return Object.assign({
    role: 'player', createdAt: LAUNCH_AT - 1,
    unlocked: { titles: [], dex: [] }, equipped: { dex: [] },
    tasks: { career: {}, special: {} }, stats: {}, games: { poker: {} }, titleState: {}
  }, overrides || {});
}

assert.strictEqual(LAUNCH_AT, Date.UTC(2026, 8, 27, 16, 0, 0));
assert.strictEqual(TITLES.length, 31);

const rich = player({ tasks: { career: { loginDays: 999, plays: 999, dailyDone: 999 }, special: {} } });
assert.deepStrictEqual(automaticUnlocks(rich, LAUNCH_AT - 1), []);
assert.strictEqual(progressMap(rich, LAUNCH_AT + 1, { peakNet: 0 }).A04.current, 0);
for (let i = 0; i < 30; i++) recordTitleProgress(rich, LAUNCH_AT + i * 86400000, 'login');
recordTitleProgress(rich, LAUNCH_AT + 1, 'play', 100);
recordTitleProgress(rich, LAUNCH_AT + 1, 'dailyDone', 100);
const richUnlocked = automaticUnlocks(rich, LAUNCH_AT + 12 * 3600000, { peakNet: 5000000 });
['A01', 'A02', 'A03', 'A04', 'A05', 'B01', 'B02', 'B03', 'B04', 'L01', 'L03'].forEach((id) => assert(richUnlocked.includes(id), id));
assert(!richUnlocked.includes('B05'));

const hiddenForPlayer = publicTitle(BY_ID.H01, false, false);
const limitedForPlayer = publicTitle(BY_ID.L01, true, false);
assert.strictEqual(hiddenForPlayer.condition, '？？？');
assert.strictEqual(hiddenForPlayer.effect, '？？？');
assert.strictEqual(limitedForPlayer.condition, '？？？');
assert.strictEqual(limitedForPlayer.effect, '？？？');
assert.notStrictEqual(publicTitle(BY_ID.L01, false, true).condition, '？？？');

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

const dirty = player({
  unlocked: { titles: ['L04', 'A01'], dex: ['dex_01'] },
  equipped: { title: 'L04', dex: ['dex_01'] },
  titleState: { showcase: ['A01'], daily: { day: dayOf(at), activeId: 'L04' }, adminRevoked: ['A02'] }
});
clearTitles(dirty, at);
assert.deepStrictEqual(dirty.unlocked.titles, []);
assert.strictEqual(dirty.equipped.title, null);
assert.deepStrictEqual(dirty.titleState.showcase, []);
assert.deepStrictEqual(dirty.titleState.adminRevoked, []);
assert.strictEqual(dirty.titleState.resetVersion, TITLE_RESET_VERSION);

const admin = player({ role: 'admin', unlocked: { titles: [], avatars: ['old'], dex: [] } });
unlockAdminCollections(admin, {
  av_1: { type: 'avatar' }, bg_1: { type: 'bg' }, bk_1: { type: 'back' },
  dex_1: { type: 'dex' }, fx_1: { type: 'effect' }
});
assert.strictEqual(admin.unlocked.titles.length, TITLES.length);
assert.deepStrictEqual(admin.unlocked.avatars, ['old', 'av_1']);
assert.deepStrictEqual(admin.unlocked.bgs, ['bg_1']);
assert.deepStrictEqual(admin.unlocked.backs, ['bk_1']);
assert.deepStrictEqual(admin.unlocked.dex, ['dex_1']);
assert.strictEqual(admin.unlocked.effects, undefined);

console.log('titles tests ok');
