'use strict';
const assert = require('assert');
const {
  FIRST_SEASON_ID, SECOND_SEASON_ID, firstSeasonAvatarMail, seasonAvatarMail
} = require('./core/season');
const { merge } = require('./core/catalog');
const { grantAdminSeasonTwoAvatars, ADMIN_SEASON_TWO_AVATAR_IDS } = require('./core/auth');

const at = Date.UTC(2026, 8, 27, 16, 1, 0);
for (let rank = 1; rank <= 3; rank++) {
  const mail = firstSeasonAvatarMail(FIRST_SEASON_ID, false, { pid: '0' + rank, rank }, at);
  assert(mail, 'rank ' + rank + ' mail');
  assert.deepStrictEqual(mail.data.items, { ['av_s1_' + rank]: 1 });
  assert.deepStrictEqual(mail.data.toList, ['0' + rank]);
  assert.strictEqual(mail.data.at, at);
  assert.strictEqual(mail.data.kind, 'seasonOneAvatar');
}
assert.strictEqual(firstSeasonAvatarMail(FIRST_SEASON_ID, false, { pid: '04', rank: 4 }, at), null);
assert.strictEqual(firstSeasonAvatarMail('2026-W40', false, { pid: '01', rank: 1 }, at), null);
assert.strictEqual(firstSeasonAvatarMail(FIRST_SEASON_ID, true, { pid: '01', rank: 1 }, at), null);

for (let rank = 1; rank <= 3; rank++) {
  const mail = seasonAvatarMail(SECOND_SEASON_ID, false, { pid: '1' + rank, rank }, at);
  assert(mail, 'season 2 rank ' + rank + ' mail');
  assert.deepStrictEqual(mail.data.items, { ['av_s2_' + rank]: 1 });
  assert.deepStrictEqual(mail.data.toList, ['1' + rank]);
  assert.strictEqual(mail.data.at, at);
  assert.strictEqual(mail.data.kind, 'seasonTwoAvatar');
  assert.ok(mail.data.title.startsWith('第二賽季'));
}
assert.strictEqual(seasonAvatarMail(SECOND_SEASON_ID, false, { pid: '14', rank: 4 }, at), null);
assert.strictEqual(seasonAvatarMail(SECOND_SEASON_ID, true, { pid: '11', rank: 1 }, at), null);
assert.strictEqual(seasonAvatarMail('2026-W41', false, { pid: '11', rank: 1 }, at), null);

const catalog = merge(null);
for (let rank = 1; rank <= 3; rank++) {
  const avatar = catalog['av_s2_' + rank];
  assert(avatar, 'season 2 rank ' + rank + ' catalog entry');
  assert.strictEqual(avatar.sub, 'season2_rank');
  assert.strictEqual(avatar.img, 'assets/av/season2-rank-' + rank + '.webp');
  assert.strictEqual(avatar.onSale, false);
}

const admin = { role: 'admin', unlocked: { avatars: ['av_s1_1'] } };
assert.strictEqual(grantAdminSeasonTwoAvatars(admin), true);
assert.deepStrictEqual(admin.unlocked.avatars.slice(-3), ADMIN_SEASON_TWO_AVATAR_IDS);
assert.strictEqual(grantAdminSeasonTwoAvatars(admin), false, 'admin sync must be idempotent');
const player = { role: 'player', unlocked: { avatars: [] } };
assert.strictEqual(grantAdminSeasonTwoAvatars(player), false);
assert.deepStrictEqual(player.unlocked.avatars, []);

console.log('season avatar tests ok');
