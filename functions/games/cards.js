'use strict';
/* games/cards.js — 牌組、洗牌、七選五比大小
   一張牌 = 0..51，rank*4+suit；rank 0..12 = 2..A，suit 0..3 = ♠♥♦♣ */
const crypto = require('crypto');

const RANK = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const CAT = ['高牌', '一對', '兩對', '三條', '順子', '同花', '葫蘆', '四條', '同花順'];

const rankOf = (c) => (c / 4) | 0;
const suitOf = (c) => c % 4;

function shuffledDeck() {
  const d = [];
  for (let i = 0; i < 52; i++) d.push(i);
  for (let i = 51; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = d[i]; d[i] = d[j]; d[j] = t;
  }
  return d;
}

function eval5(cs) {
  const ranks = cs.map(rankOf), suits = cs.map(suitOf);
  const flush = suits.every((s) => s === suits[0]);
  const count = {};
  ranks.forEach((r) => { count[r] = (count[r] || 0) + 1; });
  const groups = Object.keys(count).map((r) => ({ r: +r, n: count[r] }))
    .sort((a, b) => b.n - a.n || b.r - a.r);
  const sorted = ranks.slice().sort((a, b) => b - a);
  let straight = false, high = sorted[0];
  if (groups.length === 5) {
    if (sorted[0] - sorted[4] === 4) straight = true;
    else if (sorted[0] === 12 && sorted[1] === 3 && sorted[4] === 0) { straight = true; high = 3; }
  }
  let cat, tie;
  if (straight && flush) { cat = 8; tie = [high]; }
  else if (groups[0].n === 4) { cat = 7; tie = [groups[0].r, groups[1].r]; }
  else if (groups[0].n === 3 && groups[1].n === 2) { cat = 6; tie = [groups[0].r, groups[1].r]; }
  else if (flush) { cat = 5; tie = sorted; }
  else if (straight) { cat = 4; tie = [high]; }
  else if (groups[0].n === 3) { cat = 3; tie = groups.map((g) => g.r); }
  else if (groups[0].n === 2 && groups[1].n === 2) { cat = 2; tie = groups.map((g) => g.r); }
  else if (groups[0].n === 2) { cat = 1; tie = groups.map((g) => g.r); }
  else { cat = 0; tie = sorted; }
  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 15 + (tie[i] === undefined ? 0 : tie[i] + 1);
  return { score, cat, high };
}

function best(cards) {
  let top = null;
  const n = cards.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
    for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const pick = [cards[a], cards[b], cards[c], cards[d], cards[e]];
      const r = eval5(pick);
      if (!top || r.score > top.score) top = { score: r.score, cat: r.cat, high: r.high, cards: pick };
    }
  top.name = nameOf(top);
  return top;
}

function nameOf(r) {
  if (r.cat === 8) return r.high === 12 ? '皇家同花順' : '同花順';
  if (r.cat === 7 || r.cat === 3 || r.cat === 1) {
    const cnt = {};
    r.cards.forEach((c) => { const k = rankOf(c); cnt[k] = (cnt[k] || 0) + 1; });
    const need = r.cat === 7 ? 4 : r.cat === 3 ? 3 : 2;
    for (const k in cnt) if (cnt[k] === need) return RANK[k] + ' ' + CAT[r.cat];
  }
  return CAT[r.cat];
}

module.exports = { shuffledDeck, best, eval5, rankOf, suitOf, RANK };
