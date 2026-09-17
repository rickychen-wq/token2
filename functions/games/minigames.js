'use strict';
/* games/minigames.js — 單人小遊戲：射龍門、拉霸機
   都用經濟系統的 mutate()：一次 transaction 裡扣注、開獎、派彩、寫流水帳。 */

const crypto = require('crypto');
const { AppError } = require('../core/util');

/* ---------- 設定 ---------- */
const DEFAULTS = {
  gate: { enabled: true, minBet: 200, maxBet: 5000, edge: 0.05 },
  slot: { enabled: true, bets: [100, 200, 500, 1000] },
  dice: { enabled: true, minBet: 100, maxTotal: 10000 }
};
function gamesCfg(raw) {
  const g = (raw && raw.games) || {};
  return {
    gate: Object.assign({}, DEFAULTS.gate, g.gate),
    slot: Object.assign({}, DEFAULTS.slot, g.slot),
    dice: Object.assign({}, DEFAULTS.dice, g.dice),
    bj: Object.assign({}, g.bj)
  };
}

/* ---------- 射龍門 ----------
   點數 2~14（A=14），每張從 13 種點數平均抽（無限副牌，機率固定好算）。
   兩柱不同：第三張在中間贏，落在外面輸 1 倍，撞柱（等於任一柱）輸 2 倍。
   兩柱相同：猜比柱子大或小，猜對贏，猜錯輸 1 倍，等於柱子輸 2 倍。
   兩柱相鄰（中間沒有牌）：不能射，只能換牌。
   賠率依機率計算，保留管理員設定的莊家優勢（預設 5%）。 */
const RANKS = 13;
function drawCard() { return crypto.randomInt(52); }         // 0~51，rank = c/4|0 (0=2 ... 12=A)
const rankOf = (c) => ((c / 4) | 0) + 2;                       // 2~14

/* 回傳 { pWin, pPost, mult }，mult 是贏的時候的淨賺倍數 */
function gateOdds(lo, hi, guess, edge) {
  let win;
  if (lo === hi) {
    if (guess === 'high') win = 14 - lo;
    else if (guess === 'low') win = lo - 2;
    else return null;
    const pWin = win / RANKS, pPost = 1 / RANKS;
    if (win <= 0) return { pWin: 0, pPost, mult: 0 };
    const pLose = 1 - pWin - pPost;
    return { pWin, pPost, mult: floor1((pLose + 2 * pPost - edge) / pWin) };
  }
  win = hi - lo - 1;
  const pWin = win / RANKS, pPost = 2 / RANKS;
  if (win <= 0) return { pWin: 0, pPost, mult: 0 };
  const pLose = 1 - pWin - pPost;
  return { pWin, pPost, mult: floor1((pLose + 2 * pPost - edge) / pWin) };
}
function floor1(x) { return Math.max(0.1, Math.floor(x * 10) / 10); }

/* ---------- 拉霸 ----------
   三個輪子，每個輪子獨立依權重抽符號。理論回報率約 94.4%。 */
const SYMBOLS = [
  { id: 'cherry', w: 30 }, { id: 'lemon', w: 24 }, { id: 'bell', w: 18 }, { id: 'star', w: 12 },
  { id: 'token', w: 6 }, { id: 'seven', w: 7 }, { id: 'diamond', w: 3 }
];
const PAY3 = { cherry: 5, lemon: 10, bell: 18, star: 35, seven: 90, token: 140, diamond: 280 };
const PAY_TWO_CHERRY = 2, PAY_FIRST_CHERRY = 0.4;
const W_TOTAL = SYMBOLS.reduce((a, s) => a + s.w, 0);

function spinReel() {
  let r = crypto.randomInt(W_TOTAL);
  for (const s of SYMBOLS) { if ((r -= s.w) < 0) return s.id; }
  return SYMBOLS[0].id;
}
function slotPayout(reels) {
  const [a, b, c] = reels;
  if (a === b && b === c) return { mult: PAY3[a], kind: 'three' };
  const ch = reels.filter((x) => x === 'cherry').length;
  if (ch === 2) return { mult: PAY_TWO_CHERRY, kind: 'twoCherry' };
  if (ch === 1 && a === 'cherry') return { mult: PAY_FIRST_CHERRY, kind: 'oneCherry' };
  return { mult: 0, kind: 'none' };
}
function slotRTP() {
  let r = 0;
  for (const a of SYMBOLS) for (const b of SYMBOLS) for (const c of SYMBOLS) {
    r += (a.w * b.w * c.w) / Math.pow(W_TOTAL, 3) * slotPayout([a.id, b.id, c.id]).mult;
  }
  return r;
}

/* ---------- 骰寶（三顆骰子，澳門標準賠率）----------
   big/small：總和 11~17 / 4~10，豹子通殺，賠 1
   odd/even：單雙，豹子通殺，賠 1
   any：任何豹子，賠 30
   tr1~tr6：指定豹子，賠 180
   t4~t17：總和點數，賠 60/30/17/12/8/6/6/6/6/8/12/17/30/60
   s1~s6：單點，出現 1/2/3 顆賠 1/2/3
   賠率都是「淨賺倍數」，贏的時候拿回本金＋淨賺。 */
const TOTAL_PAY = { 4: 60, 5: 30, 6: 17, 7: 12, 8: 8, 9: 6, 10: 6, 11: 6, 12: 6, 13: 8, 14: 12, 15: 17, 16: 30, 17: 60 };
function diceKeys() {
  const k = ['big', 'small', 'odd', 'even', 'any'];
  for (let i = 1; i <= 6; i++) k.push('tr' + i, 's' + i);
  for (let t = 4; t <= 17; t++) k.push('t' + t);
  return k;
}
const DICE_KEYS = diceKeys();
/* 回傳這個注的淨賺倍數；輸回傳 -1 */
function diceOdds(key, d) {
  const sum = d[0] + d[1] + d[2], triple = d[0] === d[1] && d[1] === d[2];
  if (key === 'big') return !triple && sum >= 11 ? 1 : -1;
  if (key === 'small') return !triple && sum <= 10 ? 1 : -1;
  if (key === 'odd') return !triple && sum % 2 === 1 ? 1 : -1;
  if (key === 'even') return !triple && sum % 2 === 0 ? 1 : -1;
  if (key === 'any') return triple ? 30 : -1;
  if (key.startsWith('tr')) return triple && d[0] === +key.slice(2) ? 180 : -1;
  if (key.startsWith('t')) return sum === +key.slice(1) ? TOTAL_PAY[sum] : -1;
  if (key.startsWith('s')) { const n = d.filter((x) => x === +key.slice(1)).length; return n ? n : -1; }
  return -1;
}

function createMini({ db, now, requireSession, requireAdmin, mutate }) {
  const cfgRef = () => db.collection('config').doc('app');
  async function loadCfg() {
    const snap = await cfgRef().get();
    return gamesCfg(snap.exists ? snap.data() : null);
  }
  function cleanBet(v, lo, hi) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new AppError('下注金額要在 ' + lo + ' 到 ' + hi + ' 之間', 'bad-bet', 'invalid-argument');
    return n;
  }

  return {
    gateOdds, slotPayout, slotRTP, gamesCfg,

    /* 發門柱（也用來換牌） */
    async gateDeal(req) {
      const s = await requireSession(req);
      const G = (await loadCfg()).gate;
      if (!G.enabled) throw new AppError('射龍門目前關閉中', 'disabled');
      let out;
      await mutate(s.pid, (acc) => {
        let a = drawCard(), b = drawCard();
        acc.gate = { posts: [a, b], at: now() };
        const lo = Math.min(rankOf(a), rankOf(b)), hi = Math.max(rankOf(a), rankOf(b));
        out = { posts: [a, b], pair: lo === hi, adjacent: hi - lo === 1 };
        return [];
      });
      return out;
    },

    async gateShoot(req) {
      const s = await requireSession(req);
      const d = req.data || {};
      const G = (await loadCfg()).gate;
      if (!G.enabled) throw new AppError('射龍門目前關閉中', 'disabled');
      const bet = cleanBet(d.bet, G.minBet, G.maxBet);
      let out;
      const r = await mutate(s.pid, (acc) => {
        if (!acc.gate || !acc.gate.posts) throw new AppError('先發門柱', 'no-posts');
        const [a, b] = acc.gate.posts;
        const lo = Math.min(rankOf(a), rankOf(b)), hi = Math.max(rankOf(a), rankOf(b));
        const guess = lo === hi ? (d.guess === 'high' || d.guess === 'low' ? d.guess : null) : null;
        if (lo === hi && !guess) throw new AppError('兩柱相同要猜大或小', 'need-guess', 'invalid-argument');
        const odds = gateOdds(lo, hi, guess, G.edge);
        if (!odds || odds.pWin <= 0) throw new AppError('這副門柱射不進，請換牌', 'no-gap');
        if (acc.wallet < bet * 2) throw new AppError('撞柱要賠 2 倍，錢包至少要有 ' + (bet * 2), 'poor');
        const c = drawCard(), v = rankOf(c);
        let result, delta;
        const post = lo === hi ? v === lo : (v === lo || v === hi);
        const inside = lo === hi ? (guess === 'high' ? v > lo : v < lo) : (v > lo && v < hi);
        if (post) { result = 'post'; delta = -bet * 2; }
        else if (inside) { result = 'win'; delta = Math.floor(bet * odds.mult); }
        else { result = 'lose'; delta = -bet; }
        acc.wallet += delta;
        delete acc.gate;
        out = { card: c, result, delta, mult: odds.mult, posts: [a, b], guess };
        return [{ type: 'game', amount: delta, wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans, note: '射龍門' + { win: '射中', lose: '沒中', post: '撞柱' }[result] }];
      });
      out.wallet = r.account.wallet;
      return out;
    },

    async slotSpin(req) {
      const s = await requireSession(req);
      const d = req.data || {};
      const SL = (await loadCfg()).slot;
      if (!SL.enabled) throw new AppError('拉霸機目前關閉中', 'disabled');
      const bet = Number(d.bet);
      if (SL.bets.indexOf(bet) < 0) throw new AppError('下注金額不對', 'bad-bet', 'invalid-argument');
      let out;
      const r = await mutate(s.pid, (acc) => {
        if (acc.wallet < bet) throw new AppError('錢包不夠', 'poor');
        const reels = [spinReel(), spinReel(), spinReel()];
        const p = slotPayout(reels);
        const win = Math.floor(bet * p.mult);
        const delta = win - bet;
        acc.wallet += delta;
        out = { reels, mult: p.mult, kind: p.kind, win, delta };
        return [{ type: 'game', amount: delta, wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans, note: '拉霸 ' + reels.join('/') }];
      });
      out.wallet = r.account.wallet;
      return out;
    },

    async diceRoll(req) {
      const s = await requireSession(req);
      const D = (await loadCfg()).dice;
      if (!D.enabled) throw new AppError('骰寶目前關閉中', 'disabled');
      const bets = (req.data && req.data.bets) || {};
      const keys = Object.keys(bets).filter((k) => Number(bets[k]) > 0);
      if (!keys.length) throw new AppError('至少要下一注', 'no-bet', 'invalid-argument');
      let total = 0;
      keys.forEach((k) => {
        if (DICE_KEYS.indexOf(k) < 0) throw new AppError('下注位置不對', 'bad-bet', 'invalid-argument');
        const v = Number(bets[k]);
        if (!Number.isInteger(v) || v < D.minBet) throw new AppError('每一注最少 ' + D.minBet, 'bad-bet', 'invalid-argument');
        total += v;
      });
      if (total > D.maxTotal) throw new AppError('一次最多下 ' + D.maxTotal, 'bad-bet', 'invalid-argument');
      let out;
      const r = await mutate(s.pid, (acc) => {
        if (acc.wallet < total) throw new AppError('錢包不夠', 'poor');
        const dice = [1 + crypto.randomInt(6), 1 + crypto.randomInt(6), 1 + crypto.randomInt(6)];
        const detail = {};
        let back = 0;
        keys.forEach((k) => {
          const m = diceOdds(k, dice), v = Number(bets[k]);
          detail[k] = m > 0 ? v + v * m : 0;
          back += detail[k];
        });
        const delta = back - total;
        acc.wallet += delta;
        out = { dice, detail, total, back, delta };
        return [{ type: 'game', amount: delta, wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans, note: '骰寶 ' + dice.join('-') }];
      });
      out.wallet = r.account.wallet;
      return out;
    },

    async adminGames(req) {
      await requireAdmin(req);
      const d = req.data || {};
      const snap = await cfgRef().get();
      const cur = gamesCfg(snap.exists ? snap.data() : null);
      const next = { gate: cur.gate, slot: cur.slot, bj: cur.bj, dice: cur.dice };
      const int = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new AppError(name + '數值不合理', 'bad-config', 'invalid-argument'); return n; };
      if (d.gate) {
        if (d.gate.enabled !== undefined) next.gate.enabled = !!d.gate.enabled;
        if (d.gate.minBet !== undefined) next.gate.minBet = int(d.gate.minBet, 1, 1e7, '射龍門最低下注');
        if (d.gate.maxBet !== undefined) next.gate.maxBet = int(d.gate.maxBet, 1, 1e7, '射龍門最高下注');
        if (d.gate.edge !== undefined) { const e = Number(d.gate.edge); if (!(e >= 0 && e <= 0.5)) throw new AppError('莊家優勢要在 0 到 0.5', 'bad-config', 'invalid-argument'); next.gate.edge = e; }
        if (next.gate.minBet > next.gate.maxBet) throw new AppError('最低下注不能比最高高', 'bad-config', 'invalid-argument');
      }
      if (d.slot) {
        if (d.slot.enabled !== undefined) next.slot.enabled = !!d.slot.enabled;
        if (d.slot.bets !== undefined) {
          const b = (Array.isArray(d.slot.bets) ? d.slot.bets : []).map((x) => int(x, 1, 1e7, '拉霸下注'));
          if (!b.length || b.length > 6) throw new AppError('拉霸下注選項要 1 到 6 個', 'bad-config', 'invalid-argument');
          next.slot.bets = b.sort((x, y) => x - y);
        }
      }
      if (d.dice) {
        const dc = Object.assign({}, next.dice || DEFAULTS.dice);
        if (d.dice.enabled !== undefined) dc.enabled = !!d.dice.enabled;
        if (d.dice.minBet !== undefined) dc.minBet = int(d.dice.minBet, 1, 1e7, '骰寶最低下注');
        if (d.dice.maxTotal !== undefined) dc.maxTotal = int(d.dice.maxTotal, 1, 1e8, '骰寶單次上限');
        next.dice = dc;
      }
      if (d.bj) {
        const bj = Object.assign({}, next.bj);
        if (d.bj.enabled !== undefined) bj.enabled = !!d.bj.enabled;
        ['minBet', 'maxBet', 'betSec', 'turnSec', 'resultSec'].forEach((k) => {
          if (d.bj[k] !== undefined) bj[k] = int(d.bj[k], 1, 1e7, '21點設定');
        });
        next.bj = bj;
      }
      if (snap.exists) await cfgRef().update({ games: next }); else await cfgRef().set({ games: next, registrationOpen: false });
      return { games: next };
    }
  };
}

module.exports = { createMini, gateOdds, slotPayout, slotRTP, gamesCfg, SYMBOLS, PAY3, diceOdds, DICE_KEYS };
