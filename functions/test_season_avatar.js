'use strict';
const assert = require('assert');
const { FIRST_SEASON_ID, firstSeasonAvatarMail } = require('./core/season');

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

console.log('season avatar tests ok');
