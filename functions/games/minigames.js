'use strict';
/* games/minigames.js — 單人小遊戲：射龍門、拉霸機
   都用經濟系統的 mutate()：一次 transaction 裡扣注、開獎、派彩、寫流水帳。 */

const crypto = require('crypto');
const { AppError } = require('../core/util');
const E = require('../core/econ');
const TK = require('../core/tasks');
const { publishHighlights } = require('../core/highlights');

/* ---------- 設定 ---------- */
const DEFAULTS = {
  gate: { enabled: true, minBet: 200, maxBet: 5000, edge: 0.05 },
  slot: { enabled: true, bets: [100, 200, 500, 1000] },
  dice: { enabled: true, minBet: 100, maxTotal: 10000 }
};
/* 後台的「單一遊戲每日最多計入幾場」，0 = 不限（預設）。
   拉霸一分鐘可以轉幾十次，哪天發現有人在刷每日排行獎勵，把這個數字調大於 0 就好。 */
function playCap(raw) {
  const v = Math.floor(Number(((raw || {}).rewards || {}).dailyCapPerGame) || 0);
  return v > 0 ? v : 0;
}

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
   v11：改成真正的「單副 52 張牌」。每一輪（發門柱）洗一副新牌，門柱從牌堆 pop 兩張，
   射出去的第三張從同一副牌剩下的 50 張再 pop 一張。同一輪三張牌不可能是同一張 card id，
   兩柱可以同點數但一定不同花色；帳戶只保存門柱，不保存尚未出現的牌，伺服器是唯一判定來源。
   card id 0~51：rank = (c/4|0)+2（2~14，A=14），suit = c%4。
   兩柱不同：第三張在中間贏，落在外面輸 1 倍，撞柱（等於任一柱點數）輸 2 倍。
   兩柱相同：猜比柱子大或小，猜對贏，猜錯輸 1 倍，等於柱子輸 2 倍。
   兩柱相鄰（中間沒有牌）：不能射，只能換牌。
   賠率依「剩下 50 張」的真實機率計算，保留管理員設定的莊家優勢（預設 5%）。 */
const REST = 50;                                               // 發完兩張門柱後牌堆剩下的張數
const rankOf = (c) => ((c / 4) | 0) + 2;                       // 2~14

/* 洗一副 52 張（Fisher-Yates，用 crypto 亂數） */
function newDeck() {
  const d = [];
  for (let i = 0; i < 52; i++) d.push(i);
  for (let i = 51; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const x = d[i]; d[i] = d[j]; d[j] = x;
  }
  return d;
}

/* 回傳 { pWin, pPost, mult }，mult 是贏的時候的淨賺倍數。
   機率基準是「剛發完門柱、牌堆剩 50 張」，所以前端算出來的跟伺服器結算完全一致。 */
function gateOdds(lo, hi, guess, edge) {
  let win, post;
  if (lo === hi) {
    post = 2;                                    // 同點數的四張裡兩張當了門柱，還剩兩張
    if (guess === 'high') win = (14 - lo) * 4;
    else if (guess === 'low') win = (lo - 2) * 4;
    else return null;
  } else {
    post = 6;                                    // 兩個點數各被抽走一張，各還剩三張
    win = (hi - lo - 1) * 4;
  }
  const pWin = win / REST, pPost = post / REST;
  if (win <= 0) return { pWin: 0, pPost, mult: 0 };
  const pLose = 1 - pWin - pPost;
  return { pWin, pPost, mult: floor1((pLose + 2 * pPost - edge) / pWin) };
}
/* 賠率無條件捨去到小數第二位。
   v11 說明：改成有限牌組後，撞柱機率從 2/13 掉到 6/50，極端門柱（22 猜大、AA 猜小）
   的理論賠率只有 0.03 倍，舊的「最低 0.1 倍」會讓那種注變成正期望值（玩家 +1.6%），
   所以下限跟著改成 0.01，莊家優勢才會在每一種門柱上都成立。 */
function floor1(x) { return Math.max(0.01, Math.floor(x * 100) / 100); }

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
      let out;
      await mutate(s.pid, (acc, cfg, t, raw, pl, setPl) => {
        if (!gamesCfg(raw).gate.enabled) throw new AppError('射龍門目前關閉中', 'disabled');
        const deck = newDeck();
        const a = deck.pop(), b = deck.pop();
        // 不把剩餘牌堆放進玩家可讀的帳戶文件；第三張結算時由後端從扣除門柱後的集合抽出。
        acc.gate = { version: 2, posts: [a, b], at: now() };
        const lo = Math.min(rankOf(a), rankOf(b)), hi = Math.max(rankOf(a), rankOf(b));
        out = { posts: [a, b], pair: lo === hi, adjacent: hi - lo === 1 };
        return [];
      });
      return out;
    },

    async gateShoot(req) {
      const s = await requireSession(req);
      const d = req.data || {};
      let out;
      const r = await mutate(s.pid, (acc, cfg, t, raw, pl, setPl) => {
        const G = gamesCfg(raw).gate;
        if (!G.enabled) throw new AppError('射龍門目前關閉中', 'disabled');
        const bet = cleanBet(d.bet, G.minBet, G.maxBet);
        if (!acc.gate || !acc.gate.posts) throw new AppError('先發門柱', 'no-posts');
        const [a, b] = acc.gate.posts;
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a >= 52 || b < 0 || b >= 52 || a === b) {
          throw new AppError('門柱資料已過期，請按換牌重新發門柱', 'stale-deck');
        }
        const lo = Math.min(rankOf(a), rankOf(b)), hi = Math.max(rankOf(a), rankOf(b));
        const guess = lo === hi ? (d.guess === 'high' || d.guess === 'low' ? d.guess : null) : null;
        if (lo === hi && !guess) throw new AppError('兩柱相同要猜大或小', 'need-guess', 'invalid-argument');
        const odds = gateOdds(lo, hi, guess, G.edge);
        if (!odds || odds.pWin <= 0) throw new AppError('這副門柱射不進，請換牌', 'no-gap');
        if (acc.wallet < bet * 2) throw new AppError('撞柱要賠 2 倍，錢包至少要有 ' + (bet * 2), 'poor');
        let c;
        if (acc.gate.version === 2) {
          // 一副 52 張扣掉兩張門柱後，直接從剩下的 50 張抽；不是重複才重抽。
          const remaining = [];
          for (let id = 0; id < 52; id++) if (id !== a && id !== b) remaining.push(id);
          c = remaining[crypto.randomInt(remaining.length)];
        } else if (Array.isArray(acc.gate.deck) && acc.gate.deck.length) {
          // 相容部署前已經發出的 v11 回合，結算完就會刪除舊的公開牌堆。
          const oldDeck = acc.gate.deck.filter((id) => Number.isInteger(id) && id >= 0 && id < 52 && id !== a && id !== b);
          if (!oldDeck.length) throw new AppError('牌組資料已過期，請按換牌重新發門柱', 'stale-deck');
          c = oldDeck[oldDeck.length - 1];
        } else {
          throw new AppError('牌組已更新，請按換牌重新發門柱', 'stale-deck');
        }
        const v = rankOf(c);
        let result, delta;
        const post = lo === hi ? v === lo : (v === lo || v === hi);
        const inside = lo === hi ? (guess === 'high' ? v > lo : v < lo) : (v > lo && v < hi);
        if (post) { result = 'post'; delta = -bet * 2; }
        else if (inside) { result = 'win'; delta = Math.floor(bet * odds.mult); }
        else { result = 'lose'; delta = -bet; }
        acc.wallet += delta;
        delete acc.gate;
        if (E.recordPlay(acc, t, 'gate', playCap(raw))) { if (TK.bump(pl, t, 'play', 1, raw)) setPl({ tasks: pl.tasks }); }
        out = { card: c, result, delta, mult: odds.mult, posts: [a, b], guess };
        return [{ type: 'game', amount: delta, wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans, note: '射龍門' + { win: '射中', lose: '沒中', post: '撞柱' }[result] }];
      });
      out.wallet = r.account.wallet;
      return out;
    },

    async slotSpin(req) {
      const s = await requireSession(req);
      const d = req.data || {};
      let out, highlight;
      const r = await mutate(s.pid, (acc, cfg, t, raw, pl, setPl) => {
        const SL = gamesCfg(raw).slot;
        if (!SL.enabled) throw new AppError('拉霸機目前關閉中', 'disabled');
        const bet = Number(d.bet);
        if (SL.bets.indexOf(bet) < 0) throw new AppError('下注金額不對', 'bad-bet', 'invalid-argument');
        if (acc.wallet < bet) throw new AppError('錢包不夠', 'poor');
        const reels = [spinReel(), spinReel(), spinReel()];
        const p = slotPayout(reels);
        const win = Math.floor(bet * p.mult);
        const delta = win - bet;
        acc.wallet += delta;
        let taskChanged = false;
        if (E.recordPlay(acc, t, 'slot', playCap(raw))) taskChanged = TK.bump(pl, t, 'play', 1, raw);
        out = { reels, mult: p.mult, kind: p.kind, win, delta };
        if (p.mult >= 35) {
          taskChanged = TK.bump(pl, t, 'highlight', 1, raw) || taskChanged;
          highlight = {
            id: 'slot-' + s.pid + '-' + t,
            type: 'slot', pid: s.pid, name: pl.name || s.pid, at: t,
            mult: p.mult, bet, amount: win
          };
        }
        if (taskChanged) setPl({ tasks: pl.tasks });
        return [{ type: 'game', amount: delta, wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans, note: '拉霸 ' + reels.join('/') }];
      });
      if (highlight) await publishHighlights(db, [highlight]);
      out.wallet = r.account.wallet;
      return out;
    },

    async diceRoll(req) {
      const s = await requireSession(req);
      const bets = (req.data && req.data.bets) || {};
      const keys = Object.keys(bets).filter((k) => Number(bets[k]) > 0);
      if (!keys.length) throw new AppError('至少要下一注', 'no-bet', 'invalid-argument');
      let out;
      const r = await mutate(s.pid, (acc, cfg, t, raw, pl, setPl) => {
        const D = gamesCfg(raw).dice;
        if (!D.enabled) throw new AppError('骰寶目前關閉中', 'disabled');
        let total = 0;
        keys.forEach((k) => {
          if (DICE_KEYS.indexOf(k) < 0) throw new AppError('下注位置不對', 'bad-bet', 'invalid-argument');
          const v = Number(bets[k]);
          if (!Number.isInteger(v) || v < D.minBet) throw new AppError('每一注最少 ' + D.minBet, 'bad-bet', 'invalid-argument');
          total += v;
        });
        if (total > D.maxTotal) throw new AppError('一次最多下 ' + D.maxTotal, 'bad-bet', 'invalid-argument');
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
        if (E.recordPlay(acc, t, 'dice', playCap(raw))) { if (TK.bump(pl, t, 'play', 1, raw)) setPl({ tasks: pl.tasks }); }
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
