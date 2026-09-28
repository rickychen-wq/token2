'use strict';

const assert = require('assert');
const M = require('./core/market');
const N = require('./core/newsroom');

const MON_0700 = Date.UTC(2026, 9, 4, 23, 0, 0); // 2026-10-05（一）07:00 台灣
const MON_0800 = MON_0700 + 60 * 60000;
const MON_0655 = MON_0700 - 5 * 60000;
const MON_1605 = MON_0700 + (9 * 60 + 5) * 60000;
const MON_1610 = MON_1605 + 5 * 60000;
const SAT_1000 = Date.UTC(2026, 9, 10, 2, 0, 0);

function seeded(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

assert.strictEqual(N.newsroomWindow(MON_0700), true);
assert.strictEqual(N.newsroomWindow(MON_0655), false);
assert.strictEqual(N.newsroomWindow(MON_0800), true);
assert.strictEqual(N.newsroomWindow(MON_1605), true);
assert.strictEqual(N.newsroomWindow(MON_1610), false);
assert.strictEqual(N.newsroomWindow(SAT_1000), false);

const state = M.freshState(MON_0800);
const event = {
  id: 'ev-test-1', symbol: 'TKN', dir: 'up', size: 0.4,
  hintSlot: 12, slot: 24, hinted: 0, applied: 0
};
const built = N.buildEventCluster(event, state, MON_0800, () => 0.4);
assert.strictEqual(built.cluster.id, 'event-20261005-ev-test-1');
assert.strictEqual(built.cluster.articleIds.length, 4);
assert.strictEqual(built.articles.length, 4);
assert.deepStrictEqual(new Set(built.articles.map((x) => x.outlet)), new Set(['central', 'token', 'royal', 'deepnet']));
assert.ok(built.articles.every((x) => x.status === 'developing' && x.body.length >= 3));
assert.strictEqual(built.privateRow.truth, 'up');
assert.strictEqual(typeof built.privateRow.articleTruth[built.cluster.id + '-central'].accurate, 'boolean');
assert.strictEqual(built.privateRow.articleTruth[built.cluster.id + '-royal'].accurate, false);

// 公開文章不能直接洩漏事件方向、預定幅度或媒體正確答案。
const publicJson = JSON.stringify({ cluster: built.cluster, articles: built.articles });
assert.strictEqual(publicJson.includes('"truth"'), false);
assert.strictEqual(publicJson.includes('"magnitude"'), false);
assert.strictEqual(publicJson.includes('"accurate"'), false);
assert.strictEqual(publicJson.includes('"dir"'), false);

const room = N.freshNewsroom(MON_0800);
N.prependCluster(room, built, MON_0800);
assert.ok(built.articles.some((x) => x.id === room.leadId));
assert.strictEqual(room.clusters[0].id, built.cluster.id);
assert.strictEqual(room.articles.filter((x) => x.clusterId === built.cluster.id).length, 4);

event.applied = MON_0800 + 20 * 60000;
assert.strictEqual(N.resolveCluster(room, built.privateRow, event, event.applied), true);
assert.strictEqual(N.resolveCluster(room, built.privateRow, event, event.applied + 1), false, '同一事件只能查證一次');
const central = room.articles.find((x) => x.id.endsWith('-central'));
const royal = room.articles.find((x) => x.id.endsWith('-royal'));
assert.ok(['confirmed', 'partial'].includes(central.status));
assert.strictEqual(royal.status, 'disputed');
assert.ok(central.verdict.includes('事後查證'));

const macro = N.buildMacroCluster(state, MON_0800, seeded(7));
assert.strictEqual(macro.cluster.id, 'macro-20261005');
assert.strictEqual(macro.cluster.status, 'background');
assert.strictEqual(macro.articles.length, 3);
assert.ok(macro.articles.every((x) => !x.symbols.length && x.status === 'background'));

const normalized = N.normalizeNewsroom(room, MON_0800);
assert.strictEqual(normalized.version, 1);
assert.strictEqual(normalized.outlets.length, 4);
assert.ok(normalized.articles.length <= N.ARTICLE_LIMIT);
assert.ok(normalized.clusters.length <= N.CLUSTER_LIMIT);

const pri = N.normalizePrivate({ version: 1, rows: [built.privateRow] }, MON_0800);
assert.strictEqual(pri.rows[0].truth, 'up');
assert.strictEqual(pri.rows[0].symbol, 'TKN');

console.log('newsroom tests passed');
