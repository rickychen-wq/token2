'use strict';
/* games/big2rules.js — 台灣大老二牌型與比牌規則（純函式）
   牌的編碼沿用 cards.js：rank*4+suit，rank 0..12 = 2..A，suit 0..3 = ♠♥♦♣。

   本桌規則：沒有單獨三條、沒有普通同花；順子與葫蘆只能壓同牌型；
   鐵支與同花順是炸彈，可以跨牌型壓牌。 */

const CLUB_THREE = 7; // rank=3（索引 1）、suit=♣（索引 3）

const rankOf = (c) => (c / 4) | 0;
const suitOf = (c) => c % 4;
// 大老二點數：3 最小、2 最大。
const rankPower = (c) => (rankOf(c) + 12) % 13;
// 專案花色編碼是 ♠♥♦♣，所以轉成 ♣<♦<♥<♠ 的強度。
const suitPower = (c) => 3 - suitOf(c);

function cardPower(c) { return rankPower(c) * 4 + suitPower(c); }
function sortCards(cards) { return cards.slice().sort((a, b) => cardPower(a) - cardPower(b)); }

function compareKey(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

/* 順子由小到大：34567 ... 10JQKA、A2345、23456。
   特殊順子同點時用 2 的花色；一般順子用最高張的花色。 */
function straightInfo(cards) {
  if (cards.length !== 5) return null;
  const byRank = {};
  cards.forEach((c) => {
    const r = rankOf(c);
    if (!byRank[r]) byRank[r] = [];
    byRank[r].push(c);
  });
  const ranks = Object.keys(byRank).map(Number).sort((a, b) => a - b);
  if (ranks.length !== 5) return null;

  const sig = ranks.join(',');
  let order = -1, keyRank = -1;
  // 3～7 到 10～A，共八種一般順子。
  for (let start = 1; start <= 8; start++) {
    const want = [start, start + 1, start + 2, start + 3, start + 4].join(',');
    if (sig === want) { order = start - 1; keyRank = start + 4; break; }
  }
  if (sig === '0,1,2,3,12') { order = 8; keyRank = 0; }       // A2345
  if (sig === '0,1,2,3,4') { order = 9; keyRank = 0; }        // 23456（最大）
  if (order < 0) return null;
  const keySuit = Math.max.apply(null, byRank[keyRank].map(suitPower));
  return { order, key: [order, keySuit] };
}

function analyze(input) {
  if (!Array.isArray(input)) return null;
  const cards = input.map(Number);
  if (cards.some((c) => !Number.isInteger(c) || c < 0 || c > 51)) return null;
  if (new Set(cards).size !== cards.length) return null;
  const sorted = sortCards(cards);

  if (cards.length === 1) {
    return { type: 'single', name: '單張', cards: sorted, key: [rankPower(cards[0]), suitPower(cards[0])], bomb: false };
  }
  if (cards.length === 2 && rankOf(cards[0]) === rankOf(cards[1])) {
    return { type: 'pair', name: '對子', cards: sorted, key: [rankPower(cards[0]), Math.max(suitPower(cards[0]), suitPower(cards[1]))], bomb: false };
  }
  if (cards.length !== 5) return null;

  const count = {};
  cards.forEach((c) => { const r = rankOf(c); count[r] = (count[r] || 0) + 1; });
  const groups = Object.keys(count).map((r) => ({ rank: +r, count: count[r] }))
    .sort((a, b) => b.count - a.count || rankPower(a.rank * 4) - rankPower(b.rank * 4));
  const straight = straightInfo(cards);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));

  if (straight && flush) {
    return { type: 'straightFlush', name: '同花順', cards: sorted, key: straight.key, bomb: true };
  }
  if (groups[0].count === 4) {
    return { type: 'four', name: '鐵支', cards: sorted, key: [rankPower(groups[0].rank * 4)], bomb: true };
  }
  if (groups[0].count === 3 && groups[1].count === 2) {
    return { type: 'fullHouse', name: '葫蘆', cards: sorted, key: [rankPower(groups[0].rank * 4)], bomb: false };
  }
  if (straight) {
    return { type: 'straight', name: '順子', cards: sorted, key: straight.key, bomb: false };
  }
  return null; // 普通同花、三條與其他組合都不成立。
}

function beats(next, prev) {
  if (!next || !prev) return false;
  if (next.bomb) {
    if (!prev.bomb) return true;
    if (next.type === 'straightFlush' && prev.type === 'four') return true;
    if (next.type === 'four' && prev.type === 'straightFlush') return false;
    if (next.type !== prev.type) return false;
    return compareKey(next.key, prev.key) > 0;
  }
  if (prev.bomb || next.type !== prev.type) return false;
  return compareKey(next.key, prev.key) > 0;
}

module.exports = {
  CLUB_THREE, rankOf, suitOf, rankPower, suitPower, cardPower, sortCards,
  straightInfo, analyze, beats, compareKey
};
